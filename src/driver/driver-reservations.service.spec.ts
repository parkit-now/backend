import { HttpStatus } from '@nestjs/common';
import { Prisma, ReservationStatus, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { FakeReservationPaymentGateway } from '../reservations/payment-gateway/fake-reservation-payment.gateway';
import { ReservationLifecycleService } from '../reservations/reservation-lifecycle.service';
import { DriverReservationsService } from './driver-reservations.service';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverService } from './driver.service';
import {
  CreateReservationResponseDto,
  DriverReservationDetailDto,
  DriverReservationStateDto,
} from './dto/reservation.dto';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');
const USER = { id: 'user-1' } as User;
const PARKING = '11111111-1111-4111-8111-111111111111';
const RES_ID = '0192f0a0-0000-7000-8000-00000000abcd';

const tx = {
  $executeRaw: jest.fn(),
  reservation: { findMany: jest.fn(), create: jest.fn() },
};

const prisma = {
  reservation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  reservationPayment: { create: jest.fn(), findFirst: jest.fn() },
  $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
};

const driverService = { quoteForReservation: jest.fn() };
const driverVehicles = { findOwnedCategory: jest.fn() };

const gateway = new FakeReservationPaymentGateway();
const lifecycle = new ReservationLifecycleService(
  prisma as unknown as PrismaService,
  gateway,
);
const service = new DriverReservationsService(
  prisma as unknown as PrismaService,
  driverService as unknown as DriverService,
  driverVehicles as unknown as DriverVehiclesService,
  lifecycle,
  gateway,
);

const input = {
  id: RES_ID,
  parkingId: PARKING,
  vehiclePlate: 'AB123CD',
  entryAt: ar('2026-09-28T10:00:00').toISOString(),
  exitAt: ar('2026-09-28T12:00:00').toISOString(),
};

const baseRow = () => ({
  id: RES_ID,
  tenantId: PARKING,
  userId: USER.id,
  vehiclePlate: 'AB123CD',
  entryAt: ar('2026-09-28T10:00:00'),
  exitAt: ar('2026-09-28T12:00:00'),
  totalArs: new Prisma.Decimal(9000),
  rateSnapshotName: 'RESERVAS',
  rateSnapshotHourPriceArs: new Prisma.Decimal(4500),
  status: ReservationStatus.confirmed as ReservationStatus,
  cancelledAt: null as Date | null,
  cancelledBy: null as string | null,
  reason: null as string | null,
  holdExpiresAt: null as Date | null,
  paidAt: null as Date | null,
  approvalDeadlineAt: null as Date | null,
  refundStatus: 'none',
  refundedAmountArs: null as Prisma.Decimal | null,
  policySnapshot: null as unknown,
  payments: [] as Record<string, unknown>[],
  createdAt: NOW,
  updatedAt: NOW,
  tenant: {
    name: 'Estacionamiento Once',
    address: 'BARTOLOME MITRE 2500',
    latitude: new Prisma.Decimal(-34.6086),
    longitude: new Prisma.Decimal(-58.4019),
  },
});

const row = (overrides: Partial<ReturnType<typeof baseRow>> = {}) => ({
  ...baseRow(),
  ...overrides,
});

async function expectFailure(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
) {
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toBeInstanceOf(FormattedException);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toMatchObject({
    status,
    response: expect.objectContaining({ code }) as unknown,
  });
}

describe('DriverReservationsService', () => {
  const quoted = (entryAt: string, exitAt: string, reservableSpots = 3) => ({
    quote: {
      entryAt,
      exitAt,
      totalArs: 9000,
      rate: {
        name: 'RESERVAS',
        hourPriceArs: 4500,
        fractionPriceArs: 375,
        mediaEstadiaPriceArs: 27000,
        stayPriceArs: 45000,
      },
    },
    reservableSpots,
    policy: {
      freeCancelMinutes: 60,
      lateCancelRefundPct: 50,
      earlyArrivalMinutes: 15,
      graceMinutes: 30,
      acceptanceMode: 'auto',
      approvalWindowMinutes: 15,
    },
  });
  const window = (from: string, to: string) => ({
    entryAt: ar(`2026-09-28T${from}:00`),
    exitAt: ar(`2026-09-28T${to}:00`),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.checkouts.length = 0;
    gateway.nextCheckoutError = null;
    prisma.reservationPayment.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'pay-1', createdAt: NOW, ...data }),
    );
    prisma.reservation.findUnique.mockResolvedValue(null);
    driverVehicles.findOwnedCategory.mockResolvedValue('car');
    driverService.quoteForReservation.mockResolvedValue(
      quoted(input.entryAt, input.exitAt),
    );
    tx.reservation.findMany.mockResolvedValue([window('09:00', '11:00')]);
    tx.reservation.create.mockResolvedValue(row());
  });

  describe('create', () => {
    it('recotiza en el servidor y guarda los snapshots', async () => {
      const result = await service.create(USER, input, NOW);

      expect(driverService.quoteForReservation).toHaveBeenCalledWith(
        PARKING,
        { entryAt: input.entryAt, exitAt: input.exitAt },
        NOW,
        'car',
      );
      const [args] = tx.reservation.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).toMatchObject({
        id: RES_ID,
        tenantId: PARKING,
        userId: USER.id,
        vehiclePlate: 'AB123CD',
        totalArs: 9000,
        rateSnapshotName: 'RESERVAS',
        rateSnapshotHourPriceArs: 4500,
        rateSnapshotFractionPriceArs: 375,
        rateSnapshotMediaEstadiaPriceArs: 27000,
        rateSnapshotStayPriceArs: 45000,
      });
      // Snapshot de la categoría del vehículo del conductor al reservar.
      expect(args.data).toMatchObject({ vehicleCategory: 'car' });
      expect(result).toMatchObject({
        state: DriverReservationStateDto.active,
        cancellable: true,
        totalArs: 9000,
        code: 'R-00ABCD',
      });
    });

    it('rechaza cuando el pico de reservas simultáneas llena el cupo', async () => {
      tx.reservation.findMany.mockResolvedValue([
        window('09:00', '11:00'),
        window('10:30', '12:00'),
        window('11:00', '13:00'),
      ]);
      // Nunca hay más de dos a la vez (a las 11 una sale y la otra entra):
      // pico 2 < 3, entra.
      await service.create(USER, input, NOW);
      expect(tx.reservation.create).toHaveBeenCalled();

      tx.reservation.create.mockClear();
      driverService.quoteForReservation.mockResolvedValue(
        quoted(input.entryAt, input.exitAt, 2),
      );
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NO_CAPACITY',
      );
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('reservas que tocan la ventana sin coincidir ocupan una sola plaza', async () => {
      tx.reservation.findMany.mockResolvedValue([
        window('10:00', '10:30'),
        window('11:30', '12:00'),
      ]);
      driverService.quoteForReservation.mockResolvedValue(
        quoted(input.entryAt, input.exitAt, 2),
      );
      await service.create(USER, input, NOW);
      expect(tx.reservation.create).toHaveBeenCalled();
    });

    it('rechaza una patente que no es de un vehículo del conductor', async () => {
      driverVehicles.findOwnedCategory.mockResolvedValue(null);
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RESERVATION_VEHICLE_NOT_FOUND',
      );
      expect(driverVehicles.findOwnedCategory).toHaveBeenCalledWith(
        USER,
        'AB123CD',
      );
      expect(driverService.quoteForReservation).not.toHaveBeenCalled();
    });

    it('es idempotente: el mismo id devuelve la reserva existente', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row());
      const result = (await service.create(
        USER,
        input,
        NOW,
      )) as DriverReservationDetailDto;
      expect(result.id).toBe(RES_ID);
      expect(driverService.quoteForReservation).not.toHaveBeenCalled();
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('rechaza un id ya usado por otro conductor', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row({ userId: 'otro' }));
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_ID_CONFLICT',
      );
    });
  });

  describe('list y cancel', () => {
    it('lista sólo las del conductor y deriva el estado', async () => {
      prisma.reservation.findMany.mockResolvedValue([
        row(),
        row({ id: 'b', exitAt: ar('2026-09-26T12:00:00') }),
        row({ id: 'c', status: ReservationStatus.cancelled, cancelledAt: NOW }),
      ]);
      const result = await service.list(USER, NOW);
      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER.id } }),
      );
      expect(result.map((r) => r.state)).toEqual([
        DriverReservationStateDto.active,
        DriverReservationStateDto.completed,
        DriverReservationStateDto.cancelled,
      ]);
    });

    it('cancel delega en el ciclo de vida y devuelve la reserva actualizada', async () => {
      const driverCancel = jest
        .spyOn(lifecycle, 'driverCancel')
        .mockResolvedValue({ changed: true, reservation: {} as never });
      prisma.reservation.findUnique.mockResolvedValue(
        row({ status: ReservationStatus.cancelled, cancelledAt: NOW }),
      );
      const result = await service.cancel(USER, RES_ID, NOW);
      expect(driverCancel).toHaveBeenCalledWith(USER.id, RES_ID, NOW);
      expect(result.state).toBe(DriverReservationStateDto.cancelled);
      expect(result.status).toBe('cancelled');
      driverCancel.mockRestore();
    });
  });

  describe('get y cancelPreview', () => {
    it('devuelve el detalle con estado, política y pago sin datos sensibles', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        row({
          status: ReservationStatus.pending_payment,
          holdExpiresAt: new Date(NOW.getTime() + 600_000),
          payments: [
            {
              status: 'created',
              checkoutUrl: 'https://fake.checkout/x',
              providerPreferenceId: 'pref',
              providerPaymentId: 'secret',
            },
          ],
        }),
      );
      const result = await service.get(USER, RES_ID, NOW);
      expect(result).toMatchObject({
        status: 'pending_payment',
        state: DriverReservationStateDto.active,
        refundStatus: 'none',
        refundedAmountArs: null,
        holdExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
        approvalDeadlineAt: null,
        payment: { status: 'created', checkoutUrl: 'https://fake.checkout/x' },
        policy: { acceptanceMode: 'auto' },
      });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('pref');
    });

    it('expone quién canceló y el motivo (lo que escribió el dueño)', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        row({
          status: ReservationStatus.rejected,
          cancelledAt: NOW,
          cancelledBy: 'owner',
          reason: 'Playa llena por evento',
        }),
      );
      expect(await service.get(USER, RES_ID, NOW)).toMatchObject({
        status: 'rejected',
        state: DriverReservationStateDto.cancelled,
        cancelledBy: 'owner',
        reason: 'Playa llena por evento',
      });
    });

    it('la reserva de otro conductor responde 404', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row({ userId: 'otro' }));
      await expectFailure(
        service.get(USER, RES_ID, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
      await expectFailure(
        service.cancelPreview(USER, RES_ID, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
    });

    it('cancelPreview calcula el reembolso con la política de la reserva', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        row({
          policySnapshot: { freeCancelMinutes: 60, lateCancelRefundPct: 50 },
        }),
      );
      expect(await service.cancelPreview(USER, RES_ID, NOW)).toEqual({
        allowed: true,
        refundArs: 9000,
        kind: 'full',
        reasonCode: 'free_window',
      });
    });
  });

  describe('create con returnUrl', () => {
    const withReturn = { ...input, returnUrl: 'parkit://reservas' };
    const pending = (extra: Record<string, unknown> = {}) =>
      row({
        status: ReservationStatus.pending_payment,
        holdExpiresAt: new Date(NOW.getTime() + 600_000),
        ...extra,
      });

    beforeEach(() => {
      tx.reservation.create.mockResolvedValue(pending());
    });

    it('un returnUrl fuera de la allowlist responde 400 sin crear nada', async () => {
      await expectFailure(
        service.create(
          USER,
          { ...withReturn, returnUrl: 'https://evil.com/x' },
          NOW,
        ),
        HttpStatus.BAD_REQUEST,
        'RESERVATION_RETURN_URL_NOT_ALLOWED',
      );
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('nace pending_payment con retención de 10 min, snapshot de la política y checkout', async () => {
      const result = (await service.create(
        USER,
        withReturn,
        NOW,
      )) as CreateReservationResponseDto;

      const [args] = tx.reservation.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).toMatchObject({
        status: 'pending_payment',
        holdExpiresAt: new Date(NOW.getTime() + 600_000),
        policySnapshot: { freeCancelMinutes: 60, acceptanceMode: 'auto' },
      });
      expect(gateway.checkouts).toHaveLength(1);
      expect(gateway.checkouts[0]).toMatchObject({
        reservation: { id: RES_ID },
        tenantId: PARKING,
        amountArs: 9000,
        returnUrl: 'parkit://reservas',
        expiresAt: new Date(NOW.getTime() + 600_000),
      });
      expect(prisma.reservationPayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          reservationId: RES_ID,
          status: 'created',
          checkoutUrl: `https://fake.checkout/${RES_ID}`,
          returnUrl: 'parkit://reservas',
        }) as unknown,
      });
      expect(result.payment).toEqual({
        checkoutUrl: `https://fake.checkout/${RES_ID}`,
        holdExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      });
      expect(result.reservation).toMatchObject({
        status: 'pending_payment',
        payment: { status: 'created' },
      });
    });

    it('el checkout se pide fuera de la transacción', async () => {
      let inTx = false;
      prisma.$transaction.mockImplementationOnce(
        async (fn: (client: typeof tx) => unknown) => {
          inTx = true;
          try {
            return await fn(tx);
          } finally {
            inTx = false;
          }
        },
      );
      const spy = jest
        .spyOn(gateway, 'createCheckout')
        .mockImplementation(() => {
          expect(inTx).toBe(false);
          return Promise.resolve({ preferenceId: 'p', checkoutUrl: 'u' });
        });
      await service.create(USER, withReturn, NOW);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('rechaza sin cupo y no pide checkout', async () => {
      driverService.quoteForReservation.mockResolvedValue(
        quoted(input.entryAt, input.exitAt, 1),
      );
      await expectFailure(
        service.create(USER, withReturn, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NO_CAPACITY',
      );
      expect(gateway.checkouts).toHaveLength(0);
    });

    it('si createCheckout falla: la reserva queda expired (checkout_unavailable) y responde 503', async () => {
      gateway.nextCheckoutError = new Error('proveedor caído');
      await expectFailure(
        service.create(USER, withReturn, NOW),
        HttpStatus.SERVICE_UNAVAILABLE,
        'RESERVATION_CHECKOUT_UNAVAILABLE',
      );
      expect(prisma.reservation.updateMany).toHaveBeenCalledWith({
        where: {
          id: RES_ID,
          tenantId: PARKING,
          status: 'pending_payment',
        },
        data: { status: 'expired', reason: 'checkout_unavailable' },
      });
      expect(prisma.reservationPayment.create).not.toHaveBeenCalled();
    });

    it('replay con la retención viva devuelve el mismo checkoutUrl sin crear otro', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        pending({
          payments: [
            {
              status: 'created',
              checkoutUrl: 'https://fake.checkout/mismo',
              returnUrl: 'parkit://reservas',
            },
          ],
        }),
      );
      const result = (await service.create(
        USER,
        withReturn,
        NOW,
      )) as CreateReservationResponseDto;
      expect(result.payment.checkoutUrl).toBe('https://fake.checkout/mismo');
      expect(gateway.checkouts).toHaveLength(0);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('replay de una reserva que ya no espera el pago no devuelve checkoutUrl', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        row({ status: ReservationStatus.confirmed }),
      );
      const result = (await service.create(
        USER,
        withReturn,
        NOW,
      )) as CreateReservationResponseDto;
      expect(result.payment.checkoutUrl).toBeNull();
      expect(gateway.checkouts).toHaveLength(0);
    });

    it('replay cuyo alta se cortó antes de guardar el pago crea el checkout', async () => {
      prisma.reservation.findUnique.mockResolvedValue(pending());
      const result = (await service.create(
        USER,
        withReturn,
        NOW,
      )) as CreateReservationResponseDto;
      expect(gateway.checkouts).toHaveLength(1);
      expect(result.payment.checkoutUrl).toBe(
        `https://fake.checkout/${RES_ID}`,
      );
    });
  });

  describe('compatibilidad sin returnUrl', () => {
    const original = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = original;
    });

    it('en producción responde 422 RESERVATION_CLIENT_OUTDATED sin tocar nada', async () => {
      process.env.NODE_ENV = 'production';
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RESERVATION_CLIENT_OUTDATED',
      );
      expect(prisma.reservation.findUnique).not.toHaveBeenCalled();
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('fuera de producción crea confirmed con snapshot, sin retención ni checkout, y responde plano', async () => {
      process.env.NODE_ENV = 'test';
      const result = (await service.create(
        USER,
        input,
        NOW,
      )) as DriverReservationDetailDto;
      const [args] = tx.reservation.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).toMatchObject({
        status: 'confirmed',
        holdExpiresAt: null,
        policySnapshot: { acceptanceMode: 'auto' },
      });
      expect(gateway.checkouts).toHaveLength(0);
      expect(result).not.toHaveProperty('reservation');
      expect(result).toMatchObject({ id: RES_ID, state: 'active' });
    });
  });

  describe('paymentRetry', () => {
    const pending = (extra: Record<string, unknown> = {}) =>
      row({
        status: ReservationStatus.pending_payment,
        holdExpiresAt: new Date(NOW.getTime() + 300_000),
        ...extra,
      });

    it('con un pago vivo devuelve el mismo checkoutUrl', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        pending({
          payments: [{ status: 'created', checkoutUrl: 'https://fake/viejo' }],
        }),
      );
      const result = await service.paymentRetry(USER, RES_ID, NOW);
      expect(result.payment.checkoutUrl).toBe('https://fake/viejo');
      expect(gateway.checkouts).toHaveLength(0);
    });

    it('si el último pago se rechazó crea un checkout nuevo con el mismo returnUrl', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        pending({
          payments: [
            {
              status: 'rejected',
              checkoutUrl: 'https://fake/viejo',
              returnUrl: 'parkit://vuelta',
            },
          ],
        }),
      );
      const result = await service.paymentRetry(USER, RES_ID, NOW);
      expect(gateway.checkouts).toHaveLength(1);
      expect(gateway.checkouts[0].returnUrl).toBe('parkit://vuelta');
      expect(result.payment.checkoutUrl).toBe(
        `https://fake.checkout/${RES_ID}`,
      );
    });

    it('con la retención vencida responde 409 RESERVATION_HOLD_EXPIRED', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        pending({ holdExpiresAt: new Date(NOW.getTime() - 1000) }),
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_HOLD_EXPIRED',
      );
      prisma.reservation.findUnique.mockResolvedValue(
        row({ status: ReservationStatus.expired }),
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_HOLD_EXPIRED',
      );
    });

    it('ya pagada responde 409 RESERVATION_ALREADY_PAID; cancelada, NOT_PAYABLE', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        row({ status: ReservationStatus.confirmed }),
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_ALREADY_PAID',
      );
      prisma.reservation.findUnique.mockResolvedValue(
        row({ status: ReservationStatus.cancelled }),
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_PAYABLE',
      );
    });

    it('con un pago ya aprobado responde 409 RESERVATION_ALREADY_PAID', async () => {
      prisma.reservation.findUnique.mockResolvedValue(
        pending({ payments: [{ status: 'approved' }] }),
      );
      await expectFailure(
        service.paymentRetry(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_ALREADY_PAID',
      );
    });
  });
});
