/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/await-thenable */
import { HttpStatus } from '@nestjs/common';
import { Prisma, type Reservation } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { FakeReservationPaymentGateway } from './payment-gateway/fake-reservation-payment.gateway';
import { FakePrisma, type Row } from './fake-reservation-prisma';
import {
  ReservationLifecycleService,
  type ReservationActor,
} from './reservation-lifecycle.service';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');
const ENTRY = ar('2026-09-28T10:00:00');
const EXIT = ar('2026-09-28T12:00:00');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'user-1';
const RES_ID = '0192f0a0-0000-7000-8000-00000000abcd';
const OWNER: ReservationActor = { userId: 'user-owner', role: 'owner' };
const OPERATOR: ReservationActor = {
  userId: 'user-operator',
  role: 'operator',
};
const minutes = (base: Date, delta: number) =>
  new Date(base.getTime() + delta * 60_000);

const reservation = (overrides: Row = {}): Row => ({
  id: RES_ID,
  tenantId: TENANT,
  userId: USER,
  vehiclePlate: 'AB123CD',
  entryAt: ENTRY,
  exitAt: EXIT,
  totalArs: new Prisma.Decimal(9000),
  status: 'pending_payment',
  holdExpiresAt: minutes(NOW, 6),
  paidAt: null,
  approvalDeadlineAt: null,
  cancelledAt: null,
  cancelledBy: null,
  reason: null,
  refundStatus: 'none',
  refundedAmountArs: null,
  refundError: null,
  refundRequestedAt: null,
  refundRequestedArs: null,
  refundAttempts: 0,
  policySnapshot: {
    freeCancelMinutes: 60,
    lateCancelRefundPct: 50,
    earlyArrivalMinutes: 15,
    graceMinutes: 30,
    acceptanceMode: 'auto',
    approvalWindowMinutes: 15,
  },
  ...overrides,
});

const payment = (overrides: Row = {}): Row => ({
  id: 'pay-1',
  reservationId: RES_ID,
  tenantId: TENANT,
  status: 'created',
  providerPreferenceId: `fake-pref-${RES_ID}`,
  providerPaymentId: null,
  createdAt: NOW,
  ...overrides,
});

const manual = (extra: Row = {}) => ({
  freeCancelMinutes: 60,
  lateCancelRefundPct: 50,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  acceptanceMode: 'manual',
  approvalWindowMinutes: 15,
  ...extra,
});

async function expectFailure(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
) {
  await expect(promise).rejects.toBeInstanceOf(FormattedException);
  await expect(promise).rejects.toMatchObject({
    status,
    response: expect.objectContaining({ code }) as unknown,
  });
}

describe('ReservationLifecycleService', () => {
  let db: FakePrisma;
  let gateway: FakeReservationPaymentGateway;
  let service: ReservationLifecycleService;

  const seed = (res: Row = {}, pay: Row | null = payment()) => {
    db.reservations.push(reservation(res));
    if (pay) db.payments.push(pay);
  };
  const snapshotOf = () => ({ ...db.reservationById() });

  beforeEach(() => {
    db = new FakePrisma();
    gateway = new FakeReservationPaymentGateway();
    service = new ReservationLifecycleService(
      db as unknown as PrismaService,
      gateway,
    );
  });

  describe('markPaid', () => {
    it('con la retención viva y modo auto: confirmed y pago aprobado', async () => {
      seed();

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result).toMatchObject({ changed: true, outcome: 'confirmed' });
      expect(db.reservationById()).toMatchObject({
        status: 'confirmed',
        paidAt: NOW,
        approvalDeadlineAt: null,
      });
      expect(db.paymentOf()).toMatchObject({
        status: 'approved',
        providerPaymentId: 'dev_1',
        approvedAt: NOW,
      });
      // Retención viva: no hace falta recontar el cupo.
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('en modo manual queda pending_approval con la fecha límite', async () => {
      seed({ policySnapshot: manual({ approvalWindowMinutes: 20 }) });

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result.outcome).toBe('pending_approval');
      expect(db.reservationById()).toMatchObject({
        status: 'pending_approval',
        paidAt: NOW,
        approvalDeadlineAt: minutes(NOW, 20),
      });
    });

    it('con la retención vencida pero con lugar: recuenta bajo lock, sin contarse a sí misma, y confirma', async () => {
      seed({ holdExpiresAt: minutes(NOW, -30) });
      db.reservableSpots = 1;

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result.outcome).toBe('confirmed');
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.capacityQueries[0].where.id).toEqual({ not: RES_ID });
      expect(db.reservationById().status).toBe('confirmed');
      expect(gateway.refunds).toHaveLength(0);
    });

    it('un pago tardío sobre una expired con lugar la confirma', async () => {
      seed({ status: 'expired', holdExpiresAt: minutes(NOW, -60) });

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result).toMatchObject({ changed: true, outcome: 'confirmed' });
      expect(db.reservationById().status).toBe('confirmed');
    });

    it('un pago tardío sobre una expired en modo manual queda por aceptar', async () => {
      seed({
        status: 'expired',
        holdExpiresAt: minutes(NOW, -60),
        policySnapshot: manual(),
      });

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result.outcome).toBe('pending_approval');
      expect(db.reservationById().approvalDeadlineAt).toEqual(minutes(NOW, 15));
    });

    it('un pago tardío sin lugar: reembolso total, system y late_payment_no_capacity', async () => {
      seed({ status: 'expired', holdExpiresAt: minutes(NOW, -60) });
      db.overlapping = [{ entryAt: ENTRY, exitAt: EXIT }];

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result).toMatchObject({
        changed: true,
        outcome: 'refunded_no_capacity',
      });
      expect(db.reservationById()).toMatchObject({
        status: 'expired',
        paidAt: NOW,
        cancelledAt: NOW,
        cancelledBy: 'system',
        reason: 'late_payment_no_capacity',
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
        refundAttempts: 1,
      });
      expect(gateway.refunds).toEqual([
        {
          tenantId: TENANT,
          providerPaymentId: 'dev_1',
          amountArs: 9000,
          idempotencyKey: `refund:${RES_ID}:1`,
        },
      ]);
      expect(db.paymentOf().status).toBe('refunded');
    });

    it('un pago tardío cuando el servicio ya no tiene cupo configurado también se reembolsa', async () => {
      seed({ status: 'expired', holdExpiresAt: minutes(NOW, -60) });
      db.reservableSpots = null;

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result.outcome).toBe('refunded_no_capacity');
    });

    it('la pending_payment con la retención vencida (sin pasar el margen) no recuenta', async () => {
      // Vencida hace 3 min: el cupo sigue tomado por el margen de 5 min.
      seed({ holdExpiresAt: minutes(NOW, -3) });
      db.overlapping = [{ entryAt: ENTRY, exitAt: EXIT }];

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result.outcome).toBe('confirmed');
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('es idempotente: un segundo aviso no cambia nada ni reembolsa de nuevo', async () => {
      seed({ status: 'expired', holdExpiresAt: minutes(NOW, -60) });
      db.overlapping = [{ entryAt: ENTRY, exitAt: EXIT }];
      await service.markPaid(RES_ID, { providerPaymentId: 'dev_1' }, NOW);
      // Ahora hay lugar: aun así no se debe confirmar lo ya reembolsado.
      db.overlapping = [];
      const before = snapshotOf();

      const again = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        minutes(NOW, 1),
      );

      expect(again).toMatchObject({ changed: false, outcome: 'ignored' });
      expect(db.reservationById()).toEqual(before);
      expect(gateway.refunds).toHaveLength(1);
    });

    it('un pago aprobado sobre una cancelada que nunca cobró: registra el pago y reembolsa todo sin cambiar el estado', async () => {
      seed(
        {
          status: 'cancelled',
          cancelledAt: NOW,
          cancelledBy: 'driver',
        },
        payment({ status: 'cancelled' }),
      );

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result).toMatchObject({
        changed: true,
        outcome: 'refunded_after_cancel',
      });
      expect(db.reservationById()).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'driver',
        paidAt: NOW,
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
      });
      expect(db.paymentOf().status).toBe('refunded');
      expect(gateway.refunds).toHaveLength(1);

      const again = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );
      expect(again).toMatchObject({ changed: false, outcome: 'ignored' });
      expect(gateway.refunds).toHaveLength(1);
    });

    it.each(['rejected', 'no_show', 'completed'])(
      'un pago sobre una %s sin cobro previo también se reembolsa',
      async (status) => {
        seed({ status });

        const result = await service.markPaid(
          RES_ID,
          { providerPaymentId: 'dev_1' },
          NOW,
        );

        expect(result.outcome).toBe('refunded_after_cancel');
        expect(db.reservationById().status).toBe(status);
        expect(gateway.refunds).toHaveLength(1);
      },
    );

    it('sobre una reserva que no espera el pago no hace nada', async () => {
      seed({ status: 'confirmed', paidAt: NOW });

      const result = await service.markPaid(
        RES_ID,
        { providerPaymentId: 'dev_1' },
        NOW,
      );

      expect(result).toMatchObject({ changed: false, outcome: 'ignored' });
      expect(db.paymentOf().status).toBe('created');
    });

    it('una reserva inexistente responde 404', async () => {
      await expectFailure(
        service.markPaid('no-existe', { providerPaymentId: 'x' }, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
    });
  });

  describe('markPaymentRejected', () => {
    it('el pago pasa a rejected y la reserva sigue en pending_payment', async () => {
      seed();

      const result = await service.markPaymentRejected(RES_ID, {
        providerStatusDetail: 'cc_rejected_insufficient_amount',
      });

      expect(result.changed).toBe(true);
      expect(db.reservationById().status).toBe('pending_payment');
      expect(db.paymentOf()).toMatchObject({
        status: 'rejected',
        providerStatusDetail: 'cc_rejected_insufficient_amount',
      });
    });

    it('sobre una reserva que ya no espera el pago no cambia nada', async () => {
      seed({ status: 'confirmed' });

      const result = await service.markPaymentRejected(RES_ID);

      expect(result.changed).toBe(false);
      expect(db.paymentOf().status).toBe('created');
    });
  });

  describe('accept', () => {
    const pendingApproval = (extra: Row = {}) =>
      seed(
        {
          status: 'pending_approval',
          paidAt: NOW,
          approvalDeadlineAt: minutes(NOW, 10),
          ...extra,
        },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

    it('pending_approval pasa a confirmed', async () => {
      pendingApproval();

      const result = await service.accept(TENANT, RES_ID, OWNER, NOW);

      expect(result.changed).toBe(true);
      expect(result.reservation.status).toBe('confirmed');
    });

    it.each(['pending_payment', 'confirmed', 'cancelled', 'completed'])(
      'desde %s responde 409 y no cambia nada',
      async (status) => {
        seed({ status });
        const before = snapshotOf();

        await expectFailure(
          service.accept(TENANT, RES_ID, OWNER, NOW),
          HttpStatus.CONFLICT,
          'RESERVATION_NOT_PENDING_APPROVAL',
        );
        expect(db.reservationById()).toEqual(before);
      },
    );

    it('con el plazo vencido aplica el vencimiento (rechazo + reembolso) y responde 409', async () => {
      pendingApproval({ approvalDeadlineAt: minutes(NOW, -1) });

      await expectFailure(
        service.accept(TENANT, RES_ID, OWNER, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_APPROVAL_EXPIRED',
      );
      expect(db.reservationById()).toMatchObject({
        status: 'rejected',
        cancelledBy: 'system',
        reason: 'approval_timeout',
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
      });
    });

    it('de otra playa responde 404', async () => {
      pendingApproval();

      await expectFailure(
        service.accept(OTHER_TENANT, RES_ID, OWNER, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
      expect(db.reservationById().status).toBe('pending_approval');
    });
  });

  describe('reject', () => {
    it('rechaza con el motivo y reembolsa todo', async () => {
      seed(
        { status: 'pending_approval', paidAt: NOW },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

      const result = await service.reject(
        TENANT,
        RES_ID,
        ' Sin lugar ',
        OWNER,
        NOW,
      );

      expect(result.reservation).toMatchObject({
        status: 'rejected',
        cancelledAt: NOW,
        cancelledBy: 'owner',
        reason: 'Sin lugar',
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
      });
      expect(gateway.refunds[0]).toMatchObject({ amountArs: 9000 });
    });

    it('desde confirmed responde 409 y no cambia nada', async () => {
      seed({ status: 'confirmed' });
      const before = snapshotOf();

      await expectFailure(
        service.reject(TENANT, RES_ID, 'x', OWNER, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_PENDING_APPROVAL',
      );
      expect(db.reservationById()).toEqual(before);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('sin motivo responde 400', async () => {
      seed({ status: 'pending_approval' });

      await expectFailure(
        service.reject(TENANT, RES_ID, '  ', OWNER, NOW),
        HttpStatus.BAD_REQUEST,
        'RESERVATION_REASON_REQUIRED',
      );
    });
  });

  describe('ownerCancel', () => {
    const paid = (status: string, extra: Row = {}) =>
      seed(
        { status, paidAt: NOW, ...extra },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

    it.each(['confirmed', 'pending_approval'])(
      'cancela una %s con reembolso total',
      async (status) => {
        paid(status);

        const result = await service.ownerCancel(
          TENANT,
          RES_ID,
          'Cierre',
          OWNER,
          NOW,
        );

        expect(result.reservation).toMatchObject({
          status: 'cancelled',
          cancelledBy: 'owner',
          reason: 'Cierre',
          refundStatus: 'refunded',
          refundedAmountArs: 9000,
        });
      },
    );

    it('puede cancelar aunque la reserva ya haya empezado', async () => {
      paid('confirmed');

      const result = await service.ownerCancel(
        TENANT,
        RES_ID,
        'Cierre',
        OWNER,
        minutes(ENTRY, 10),
      );

      expect(result.reservation.status).toBe('cancelled');
    });

    it.each([
      'pending_payment',
      'cancelled',
      'completed',
      'expired',
      'no_show',
    ])('desde %s responde 409 y no cambia nada', async (status) => {
      paid(status);
      const before = snapshotOf();

      await expectFailure(
        service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_CANCELLABLE',
      );
      expect(db.reservationById()).toEqual(before);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('sin motivo responde 400', async () => {
      paid('confirmed');

      await expectFailure(
        service.ownerCancel(TENANT, RES_ID, '', OWNER, NOW),
        HttpStatus.BAD_REQUEST,
        'RESERVATION_REASON_REQUIRED',
      );
    });
  });

  describe('driverCancel', () => {
    const paid = (status = 'confirmed', extra: Row = {}) =>
      seed(
        { status, paidAt: NOW, ...extra },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

    it('antes del corte: reembolso total', async () => {
      paid();

      const result = await service.driverCancel(USER, RES_ID, NOW);

      expect(result.reservation).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'driver',
        cancelledAt: NOW,
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
      });
      expect(db.paymentOf().status).toBe('refunded');
    });

    it('entre el corte y el inicio: el porcentaje de la playa (partial)', async () => {
      paid();

      const result = await service.driverCancel(
        USER,
        RES_ID,
        minutes(ENTRY, -30),
      );

      expect(result.reservation).toMatchObject({
        status: 'cancelled',
        refundStatus: 'partial',
        refundedAmountArs: 4500,
      });
      expect(gateway.refunds[0]).toMatchObject({ amountArs: 4500 });
      expect(db.paymentOf().status).toBe('partially_refunded');
    });

    it('tardío con 0 %: cancela sin reembolso y sin llamar al gateway', async () => {
      paid('confirmed', {
        policySnapshot: {
          ...reservation().policySnapshot,
          lateCancelRefundPct: 0,
        },
      });

      const result = await service.driverCancel(
        USER,
        RES_ID,
        minutes(ENTRY, -30),
      );

      expect(result.reservation.status).toBe('cancelled');
      expect(result.reservation.refundStatus).toBe('none');
      expect(gateway.refunds).toHaveLength(0);
    });

    it('en pending_approval: reembolso total', async () => {
      paid('pending_approval');

      const result = await service.driverCancel(
        USER,
        RES_ID,
        minutes(ENTRY, -5),
      );

      expect(Number(result.reservation.refundedAmountArs)).toBe(9000);
    });

    it('en pending_payment: invalida el checkout y no reembolsa', async () => {
      seed();

      const result = await service.driverCancel(USER, RES_ID, NOW);

      expect(result.reservation).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'driver',
        refundStatus: 'none',
      });
      expect(gateway.cancelled).toEqual([
        {
          tenantId: TENANT,
          reservationId: RES_ID,
          providerPreferenceId: `fake-pref-${RES_ID}`,
        },
      ]);
      expect(gateway.refunds).toHaveLength(0);
      expect(db.paymentOf().status).toBe('cancelled');
    });

    it('en pending_payment, si cancelPending falla igual cancela', async () => {
      seed();
      gateway.cancelPending = () => Promise.reject(new Error('mp caído'));

      const result = await service.driverCancel(USER, RES_ID, NOW);

      expect(result.reservation.status).toBe('cancelled');
    });

    it('después del inicio responde 409 y no cambia nada', async () => {
      paid();
      const before = snapshotOf();

      await expectFailure(
        service.driverCancel(USER, RES_ID, minutes(ENTRY, 1)),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_CANCELLABLE',
      );
      expect(db.reservationById()).toEqual(before);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('una reserva ya cancelada responde 409', async () => {
      paid('cancelled', { cancelledAt: NOW });

      await expectFailure(
        service.driverCancel(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_CANCELLABLE',
      );
    });

    it('la reserva de otro conductor responde 404', async () => {
      paid();

      await expectFailure(
        service.driverCancel('otro', RES_ID, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
    });
  });

  describe('reembolsos', () => {
    const confirmed = (extra: Row = {}) =>
      seed(
        { status: 'confirmed', paidAt: NOW, ...extra },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

    it('refunded: registra el intento, el monto y el pago', async () => {
      confirmed();

      await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(db.reservationById()).toMatchObject({
        refundStatus: 'refunded',
        refundedAmountArs: 9000,
        refundRequestedAt: NOW,
        refundRequestedArs: 9000,
        refundAttempts: 1,
        refundError: null,
      });
    });

    it('si el gateway tira: failed con el motivo, y la cancelación se mantiene', async () => {
      confirmed();
      gateway.nextRefundError = new Error('Sin saldo en la cuenta');

      const result = await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(result.reservation).toMatchObject({
        status: 'cancelled',
        refundStatus: 'failed',
        refundError: 'Sin saldo en la cuenta',
        refundAttempts: 1,
      });
      expect(db.paymentOf().status).toBe('approved');
    });

    it('si el proveedor lo deja pendiente: queda pending hasta el webhook', async () => {
      confirmed();
      gateway.nextRefundStatus = 'pending';

      const result = await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(result.reservation).toMatchObject({
        refundStatus: 'pending',
        refundedAmountArs: null,
      });
      expect(db.paymentOf().status).toBe('approved');
    });

    it('con 0 $ no llama al gateway y el estado queda none', async () => {
      confirmed({ totalArs: new Prisma.Decimal(0) });

      const result = await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(result.reservation.status).toBe('cancelled');
      expect(result.reservation.refundStatus).toBe('none');
      expect(result.reservation.refundAttempts).toBe(0);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('una reserva del camino viejo (nunca se cobró) se cancela sin reembolso ni alerta', async () => {
      seed({ status: 'confirmed', paidAt: null }, null);

      const result = await service.driverCancel(USER, RES_ID, NOW);

      expect(result.reservation.status).toBe('cancelled');
      expect(result.reservation.refundStatus).toBe('none');
      expect(result.reservation.refundAttempts).toBe(0);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('sin un pago aprobado que reembolsar queda failed', async () => {
      seed({ status: 'confirmed', paidAt: NOW }, null);

      const result = await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(result.reservation.refundStatus).toBe('failed');
      expect(gateway.refunds).toHaveLength(0);
    });
  });

  describe('retryRefund', () => {
    const failed = () => {
      seed(
        {
          status: 'cancelled',
          cancelledAt: NOW,
          cancelledBy: 'driver',
          paidAt: NOW,
          refundStatus: 'failed',
          refundError: 'boom',
          refundAttempts: 1,
          refundRequestedArs: new Prisma.Decimal(4500),
        },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );
    };

    it('reintenta con el monto pedido y una idempotencyKey nueva', async () => {
      failed();

      const result = await service.retryRefund(TENANT, RES_ID, OWNER, NOW);

      expect(gateway.refunds).toEqual([
        {
          tenantId: TENANT,
          providerPaymentId: 'dev_1',
          amountArs: 4500,
          idempotencyKey: `refund:${RES_ID}:2`,
        },
      ]);
      expect(result.reservation).toMatchObject({
        refundStatus: 'partial',
        refundedAmountArs: 4500,
        refundError: null,
        refundAttempts: 2,
      });
    });

    it('si vuelve a fallar queda failed con el intento contado', async () => {
      failed();
      gateway.nextRefundError = new Error('sigue sin saldo');

      const result = await service.retryRefund(TENANT, RES_ID, OWNER, NOW);

      expect(result.reservation).toMatchObject({
        refundStatus: 'failed',
        refundError: 'sigue sin saldo',
        refundAttempts: 2,
      });
    });

    it.each(['none', 'pending', 'refunded', 'partial'])(
      'con refundStatus %s responde 409 y no llama al gateway',
      async (refundStatus) => {
        seed({ status: 'cancelled', cancelledAt: NOW, refundStatus });
        const before = snapshotOf();

        await expectFailure(
          service.retryRefund(TENANT, RES_ID, OWNER, NOW),
          HttpStatus.CONFLICT,
          'RESERVATION_REFUND_NOT_RETRYABLE',
        );
        expect(db.reservationById()).toEqual(before);
        expect(gateway.refunds).toHaveLength(0);
      },
    );

    it('de otra playa responde 404', async () => {
      failed();

      await expectFailure(
        service.retryRefund(OTHER_TENANT, RES_ID, OWNER, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
    });
  });

  describe('transiciones del sweeper', () => {
    it('expireHold vence la pending_payment pasado el margen y cancela el checkout', async () => {
      seed({ holdExpiresAt: minutes(NOW, -6) });

      expect(await service.expireHold(RES_ID, TENANT, NOW)).toBe(true);

      expect(db.reservationById()).toMatchObject({
        status: 'expired',
        reason: 'hold_expired',
      });
      expect(db.paymentOf().status).toBe('cancelled');
      expect(gateway.cancelled).toHaveLength(1);
    });

    it('expireHold no toca una retención que todavía cuenta (margen de 5 min)', async () => {
      seed({ holdExpiresAt: minutes(NOW, -4) });

      expect(await service.expireHold(RES_ID, TENANT, NOW)).toBe(false);
      expect(db.reservationById().status).toBe('pending_payment');
    });

    it('expireHold es idempotente', async () => {
      seed({ holdExpiresAt: minutes(NOW, -6) });
      await service.expireHold(RES_ID, TENANT, NOW);

      expect(await service.expireHold(RES_ID, TENANT, NOW)).toBe(false);
      expect(gateway.cancelled).toHaveLength(1);
    });

    it('rejectByTimeout rechaza con reembolso total', async () => {
      seed(
        {
          status: 'pending_approval',
          paidAt: NOW,
          approvalDeadlineAt: minutes(NOW, -1),
        },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );

      expect(await service.rejectByTimeout(RES_ID, TENANT, NOW)).toBe(true);

      expect(db.reservationById()).toMatchObject({
        status: 'rejected',
        cancelledBy: 'system',
        reason: 'approval_timeout',
        refundStatus: 'refunded',
      });
    });

    it('rejectByTimeout no toca un plazo vigente ni otro estado', async () => {
      seed({
        status: 'pending_approval',
        approvalDeadlineAt: minutes(NOW, 5),
      });
      expect(await service.rejectByTimeout(RES_ID, TENANT, NOW)).toBe(false);

      db.reservationById().status = 'confirmed';
      db.reservationById().approvalDeadlineAt = minutes(NOW, -5);
      expect(await service.rejectByTimeout(RES_ID, TENANT, NOW)).toBe(false);
    });

    it('markNoShow pasa una confirmed con ingreso pasado a no_show, una sola vez', async () => {
      seed({ status: 'confirmed', entryAt: minutes(NOW, -60) });

      expect(await service.markNoShow(RES_ID, TENANT, NOW)).toBe(true);
      expect(db.reservationById().status).toBe('no_show');
      expect(await service.markNoShow(RES_ID, TENANT, NOW)).toBe(false);
    });
  });

  describe('auditoría', () => {
    const confirmedPaid = (extra: Row = {}) =>
      seed(
        { status: 'confirmed', paidAt: NOW, ...extra },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );
    const pendingApproval = (extra: Row = {}) =>
      confirmedPaid({
        status: 'pending_approval',
        policySnapshot: manual(),
        approvalDeadlineAt: minutes(NOW, 10),
        ...extra,
      });
    const base = {
      entityType: 'reservation',
      entityId: RES_ID,
      tenantId: TENANT,
    };

    it('accept registra al dueño con su rol', async () => {
      pendingApproval();

      await service.accept(TENANT, RES_ID, OWNER, NOW);

      expect(db.audits).toEqual([
        {
          ...base,
          action: 'reservation.accepted',
          actorUserId: 'user-owner',
          severity: 'info',
          metadata: {
            actorRole: 'owner',
            previousStatus: 'pending_approval',
            vehiclePlate: 'AB123CD',
            entryAt: ENTRY.toISOString(),
          },
        },
      ]);
    });

    it('reject registra al operador (distinto del dueño), el motivo y el reembolso', async () => {
      pendingApproval();

      await service.reject(TENANT, RES_ID, ' Sin lugar ', OPERATOR, NOW);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        ...base,
        action: 'reservation.rejected',
        actorUserId: 'user-operator',
        severity: 'info',
        metadata: {
          actorRole: 'operator',
          reason: 'Sin lugar',
          previousStatus: 'pending_approval',
          refundArs: 9000,
          refundStatus: 'pending',
          vehiclePlate: 'AB123CD',
        },
      });
      expect(db.reservationById()).toMatchObject({
        cancelledBy: 'owner',
        cancelledByUserId: 'user-operator',
      });
    });

    it('ownerCancel por un admin global registra rol admin', async () => {
      confirmedPaid();

      await service.ownerCancel(
        TENANT,
        RES_ID,
        'x',
        { userId: 'user-admin', role: 'admin' },
        NOW,
      );

      expect(db.audits[0]).toMatchObject({
        action: 'reservation.cancelled',
        actorUserId: 'user-admin',
        metadata: { actorRole: 'admin', previousStatus: 'confirmed' },
      });
    });

    it('driverCancel registra al conductor y su id en cancelled_by_user_id', async () => {
      confirmedPaid();

      await service.driverCancel(USER, RES_ID, NOW);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        action: 'reservation.cancelled',
        actorUserId: USER,
        metadata: {
          actorRole: 'driver',
          previousStatus: 'confirmed',
          refundArs: 9000,
          refundStatus: 'pending',
        },
      });
      expect(db.audits[0].metadata.reason).toBeUndefined();
      expect(db.reservationById()).toMatchObject({
        cancelledBy: 'driver',
        cancelledByUserId: USER,
      });
    });

    it('cancelar sin haber pagado audita sin reembolso', async () => {
      seed();

      await service.driverCancel(USER, RES_ID, NOW);

      expect(db.audits[0].metadata).toMatchObject({
        previousStatus: 'pending_payment',
        refundArs: 0,
        refundStatus: 'none',
      });
    });

    it('el vencimiento de la aprobación audita como sistema, sin actor', async () => {
      pendingApproval({ approvalDeadlineAt: minutes(NOW, -1) });

      await service.rejectByTimeout(RES_ID, TENANT, NOW);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        action: 'reservation.rejected',
        actorUserId: null,
        metadata: {
          actorRole: 'system',
          reasonCode: 'approval_timeout',
          refundArs: 9000,
        },
      });
      expect(db.reservationById().cancelledByUserId).toBeNull();
    });

    it('un accept fuera de plazo audita el rechazo del sistema y no una aceptación', async () => {
      pendingApproval({ approvalDeadlineAt: minutes(NOW, -1) });

      await expect(
        service.accept(TENANT, RES_ID, OWNER, NOW),
      ).rejects.toThrow();

      expect(db.audits.map((a): string => a.action as string)).toEqual([
        'reservation.rejected',
      ]);
      expect(db.audits[0].actorUserId).toBeNull();
    });

    it('si el reembolso falla audita refund_failed (warn) con el error resumido', async () => {
      confirmedPaid();
      gateway.nextRefundError = new Error('x'.repeat(400));

      await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);

      expect(db.audits.map((a): string => a.action as string)).toEqual([
        'reservation.cancelled',
        'reservation.refund_failed',
      ]);
      const failed = db.audits[1];
      expect(failed).toMatchObject({
        severity: 'warn',
        actorUserId: 'user-owner',
        metadata: {
          actorRole: 'owner',
          previousStatus: 'cancelled',
          refundArs: 9000,
          refundStatus: 'failed',
        },
      });
      expect(failed.metadata.refundError).toHaveLength(200);
    });

    it('retryRefund audita quién reintenta; si vuelve a fallar, también refund_failed', async () => {
      seed(
        {
          status: 'cancelled',
          paidAt: NOW,
          refundStatus: 'failed',
          refundAttempts: 1,
          refundRequestedArs: new Prisma.Decimal(4500),
        },
        payment({ status: 'approved', providerPaymentId: 'dev_1' }),
      );
      gateway.nextRefundError = new Error('otra vez');

      await service.retryRefund(TENANT, RES_ID, OPERATOR, NOW);

      expect(db.audits.map((a): string => a.action as string)).toEqual([
        'reservation.refund_retried',
        'reservation.refund_failed',
      ]);
      expect(db.audits[0]).toMatchObject({
        actorUserId: 'user-operator',
        severity: 'info',
        metadata: {
          actorRole: 'operator',
          previousStatus: 'cancelled',
          refundArs: 4500,
          attempt: 2,
        },
      });
    });

    it('el pago tardío sin cupo audita como sistema', async () => {
      seed({ status: 'expired', holdExpiresAt: minutes(NOW, -60) });
      db.overlapping = [{ entryAt: ENTRY, exitAt: EXIT }];

      await service.markPaid(RES_ID, { providerPaymentId: 'dev_1' }, NOW);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        action: 'reservation.late_payment_refunded',
        actorUserId: null,
        severity: 'info',
        metadata: {
          actorRole: 'system',
          reasonCode: 'late_payment_no_capacity',
          previousStatus: 'expired',
          refundArs: 9000,
        },
      });
    });

    it('el pago sobre una reserva cancelada audita como sistema, una sola vez', async () => {
      seed({ status: 'cancelled', cancelledAt: NOW });

      await service.markPaid(RES_ID, { providerPaymentId: 'dev_1' }, NOW);
      await service.markPaid(RES_ID, { providerPaymentId: 'dev_1' }, NOW);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        action: 'reservation.late_payment_refunded',
        actorUserId: null,
        metadata: { actorRole: 'system', reasonCode: 'payment_after_cancel' },
      });
    });

    it('una transición inválida o repetida no audita', async () => {
      confirmedPaid();
      await expect(
        service.accept(TENANT, RES_ID, OWNER, NOW),
      ).rejects.toThrow();
      await expect(
        service.retryRefund(TENANT, RES_ID, OWNER, NOW),
      ).rejects.toThrow();
      await expect(
        service.reject(TENANT, RES_ID, 'x', OWNER, NOW),
      ).rejects.toThrow();
      await expect(service.driverCancel('otro', RES_ID, NOW)).rejects.toThrow();
      expect(db.audits).toHaveLength(0);

      await service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW);
      const total = db.audits.length;
      await expect(
        service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW),
      ).rejects.toThrow();
      expect(db.audits).toHaveLength(total);
    });

    it('un cancel que pierde la carrera (otro actor movió la reserva) no audita', async () => {
      confirmedPaid();
      db.reservation.updateMany = () => Promise.resolve({ count: 0 });

      await expect(
        service.ownerCancel(TENANT, RES_ID, 'x', OWNER, NOW),
      ).rejects.toThrow();

      expect(db.audits).toHaveLength(0);
    });

    it('expireHold y markNoShow no auditan', async () => {
      seed({ holdExpiresAt: minutes(NOW, -6) });
      await service.expireHold(RES_ID, TENANT, NOW);
      db.reservations = [];
      seed({ status: 'confirmed', entryAt: minutes(NOW, -60) });
      await service.markNoShow(RES_ID, TENANT, NOW);
      expect(db.audits).toHaveLength(0);
    });
  });

  describe('previewCancel', () => {
    it('en pending_payment no hay nada pagado: sin reembolso', () => {
      const row = reservation() as unknown as Reservation;
      expect(service.previewCancel(row, 'driver', NOW)).toMatchObject({
        allowed: true,
        refundArs: 0,
        kind: 'none',
      });
    });

    it('una reserva anterior a la migración (sin snapshot) usa los defaults', () => {
      const row = reservation({
        status: 'confirmed',
        policySnapshot: null,
      }) as unknown as Reservation;
      expect(service.previewCancel(row, 'driver', NOW)).toMatchObject({
        refundArs: 9000,
        kind: 'full',
      });
    });
  });
});
