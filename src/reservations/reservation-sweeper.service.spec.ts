import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import type { ReservationPaymentGateway } from './payment-gateway/reservation-payment-gateway';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationSweeperService } from './reservation-sweeper.service';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-28T12:00:00');
const minutes = (base: Date, delta: number) =>
  new Date(base.getTime() + delta * 60_000);

const prisma = {
  reservation: { findMany: jest.fn() },
  reservationPayment: { findFirst: jest.fn() },
};
const lifecycle = {
  expireHold: jest.fn(),
  rejectByTimeout: jest.fn(),
  markNoShow: jest.fn(),
  markPaid: jest.fn(),
  confirmRefund: jest.fn(),
  markRefundFailedBySystem: jest.fn(),
};
const gateway = {
  findApprovedPayment: jest.fn(),
  getPayment: jest.fn(),
};

const service = new ReservationSweeperService(
  prisma as unknown as PrismaService,
  lifecycle as unknown as ReservationLifecycleService,
  gateway as unknown as ReservationPaymentGateway,
);

const rows = (...ids: string[]) => ids.map((id) => ({ id, tenantId: 't-1' }));
const arrival = (id: string, entryAt: Date, snapshot: unknown = null) => ({
  id,
  tenantId: 't-1',
  entryAt,
  policySnapshot: snapshot,
});

/** `findMany` contesta según el estado que pide cada regla. */
function stubRules(rules: {
  holds?: unknown[];
  approvals?: unknown[];
  arrivals?: unknown[];
}) {
  prisma.reservation.findMany.mockImplementation(
    ({ where }: { where: { status: string } }) =>
      Promise.resolve(
        {
          pending_payment: rules.holds,
          pending_approval: rules.approvals,
          confirmed: rules.arrivals,
        }[where.status] ?? [],
      ),
  );
}

describe('ReservationSweeperService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lifecycle.expireHold.mockResolvedValue(true);
    lifecycle.rejectByTimeout.mockResolvedValue(true);
    lifecycle.markNoShow.mockResolvedValue(true);
    // Sin pago aprobado en el proveedor (como el gateway de dev).
    gateway.findApprovedPayment.mockResolvedValue(null);
    stubRules({});
  });

  it('sin nada que vencer no toca nada', async () => {
    expect(await service.sweep(NOW)).toEqual({
      expired: 0,
      rejected: 0,
      noShow: 0,
    });
    expect(lifecycle.expireHold).not.toHaveBeenCalled();
  });

  describe('regla 1: pending_payment vencida', () => {
    it('busca las retenciones vencidas hace más de 5 min y las vence', async () => {
      stubRules({ holds: rows('a', 'b') });

      const result = await service.sweep(NOW);

      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'pending_payment',
            holdExpiresAt: { lt: minutes(NOW, -5) },
          },
          take: 100,
        }),
      );
      expect(lifecycle.expireHold).toHaveBeenCalledWith('a', 't-1', NOW);
      expect(lifecycle.expireHold).toHaveBeenCalledWith('b', 't-1', NOW);
      expect(result.expired).toBe(2);
    });

    it('no cuenta las que otro actor ya movió', async () => {
      stubRules({ holds: rows('a', 'b') });
      lifecycle.expireHold.mockResolvedValueOnce(false);

      expect((await service.sweep(NOW)).expired).toBe(1);
    });

    it('si Mercado Pago ya la cobró (webhook perdido): la confirma y no la vence', async () => {
      stubRules({ holds: rows('a') });
      gateway.findApprovedPayment.mockResolvedValue({
        providerPaymentId: 'pay-1',
        status: 'approved',
      });
      lifecycle.markPaid.mockResolvedValue({ outcome: 'confirmed' });

      const result = await service.sweep(NOW);

      expect(gateway.findApprovedPayment).toHaveBeenCalledWith({
        tenantId: 't-1',
        reservationId: 'a',
      });
      expect(lifecycle.markPaid).toHaveBeenCalledWith('a', {
        providerPaymentId: 'pay-1',
        providerStatus: 'approved',
      });
      expect(lifecycle.expireHold).not.toHaveBeenCalled();
      expect(result.expired).toBe(0);
    });

    it('si la consulta a Mercado Pago falla: la vence igual', async () => {
      stubRules({ holds: rows('a') });
      gateway.findApprovedPayment.mockRejectedValue(new Error('MP caído'));

      const result = await service.sweep(NOW);

      expect(lifecycle.markPaid).not.toHaveBeenCalled();
      expect(lifecycle.expireHold).toHaveBeenCalledWith('a', 't-1', NOW);
      expect(result.expired).toBe(1);
    });

    it('si markPaid falla: no la vence y sigue con el lote', async () => {
      stubRules({ holds: rows('a', 'b') });
      gateway.findApprovedPayment.mockResolvedValueOnce({
        providerPaymentId: 'pay-1',
        status: 'approved',
      });
      lifecycle.markPaid.mockRejectedValue(new Error('boom'));

      const result = await service.sweep(NOW);

      expect(lifecycle.expireHold).toHaveBeenCalledTimes(1);
      expect(lifecycle.expireHold).toHaveBeenCalledWith('b', 't-1', NOW);
      expect(result.expired).toBe(1);
    });
  });

  describe('regla 2: pending_approval vencida', () => {
    it('rechaza por timeout las que pasaron su plazo', async () => {
      stubRules({ approvals: rows('a') });

      const result = await service.sweep(NOW);

      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'pending_approval',
            approvalDeadlineAt: { lt: NOW },
          },
        }),
      );
      expect(lifecycle.rejectByTimeout).toHaveBeenCalledWith('a', 't-1', NOW);
      expect(result.rejected).toBe(1);
    });
  });

  describe('regla 3: confirmed sin ingreso', () => {
    it('marca no_show cuando venció la tolerancia del snapshot', async () => {
      stubRules({
        arrivals: [
          // 31 min con tolerancia por defecto (30): vencida.
          arrival('late', minutes(NOW, -31)),
          // 31 min pero con 60 de tolerancia: todavía vale.
          arrival('grace', minutes(NOW, -31), { graceMinutes: 60 }),
          // Justo en el límite: todavía no.
          arrival('edge', minutes(NOW, -30)),
          // 15 min con 10 de tolerancia: vencida.
          arrival('short', minutes(NOW, -15), { graceMinutes: 10 }),
        ],
      });

      const result = await service.sweep(NOW);

      expect(lifecycle.markNoShow).toHaveBeenCalledTimes(2);
      expect(lifecycle.markNoShow).toHaveBeenCalledWith('late', 't-1', NOW);
      expect(lifecycle.markNoShow).toHaveBeenCalledWith('short', 't-1', NOW);
      expect(result.noShow).toBe(2);
    });

    it('sólo mira las confirmed con ingreso pasado', async () => {
      await service.sweep(NOW);

      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'confirmed', entryAt: { lt: NOW } },
        }),
      );
    });
  });

  it('una reserva que falla no corta el lote', async () => {
    stubRules({ holds: rows('a', 'b') });
    lifecycle.expireHold
      .mockRejectedValueOnce(new Error('db caída'))
      .mockResolvedValueOnce(true);

    const result = await service.sweep(NOW);

    expect(lifecycle.expireHold).toHaveBeenCalledTimes(2);
    expect(result.expired).toBe(1);
  });

  it('corre las tres reglas en la misma pasada', async () => {
    stubRules({
      holds: rows('h'),
      approvals: rows('p'),
      arrivals: [arrival('n', minutes(NOW, -90))],
    });

    expect(await service.sweep(NOW)).toEqual({
      expired: 1,
      rejected: 1,
      noShow: 1,
    });
  });

  describe('reembolsos pendientes (reconcileRefunds)', () => {
    const pendingRows = (...ids: string[]) =>
      ids.map((id) => ({ id, tenantId: 't-1' }));
    const tokenError = (code: string) =>
      new FormattedException('x', 409, 'detalle', '/x', code as never);

    beforeEach(() => {
      prisma.reservation.findMany.mockResolvedValue(pendingRows('r1'));
      prisma.reservationPayment.findFirst.mockResolvedValue({
        providerPaymentId: 'pay-1',
      });
      lifecycle.confirmRefund.mockResolvedValue({
        changed: true,
        outcome: 'refunded',
      });
      lifecycle.markRefundFailedBySystem.mockResolvedValue({ changed: true });
    });

    it('busca los pendientes con más de 10 min, en lotes de 100', async () => {
      await service.reconcileRefunds(NOW);

      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            refundStatus: 'pending',
            refundRequestedAt: { lt: minutes(NOW, -10) },
          },
          take: 100,
        }),
      );
    });

    it('un pago devuelto en el proveedor confirma el reembolso', async () => {
      gateway.getPayment.mockResolvedValue({
        providerPaymentId: 'pay-1',
        status: 'refunded',
        amountArs: 1000,
        refundedAmountArs: 1000,
      });

      const result = await service.reconcileRefunds(NOW);

      expect(gateway.getPayment).toHaveBeenCalledWith({
        tenantId: 't-1',
        providerPaymentId: 'pay-1',
      });
      expect(lifecycle.confirmRefund).toHaveBeenCalledWith(
        'r1',
        { refundedAmountArs: 1000, providerPaymentId: 'pay-1' },
        NOW,
      );
      expect(result).toEqual({ confirmed: 1, failed: 0 });
    });

    it('un reembolso parcial informa el monto devuelto', async () => {
      gateway.getPayment.mockResolvedValue({
        providerPaymentId: 'pay-1',
        status: 'partially_refunded',
        amountArs: 1000,
        refundedAmountArs: 300,
      });

      await service.reconcileRefunds(NOW);

      expect(lifecycle.confirmRefund).toHaveBeenCalledWith(
        'r1',
        { refundedAmountArs: 300, providerPaymentId: 'pay-1' },
        NOW,
      );
    });

    it('si el pago sigue aprobado, no toca nada', async () => {
      gateway.getPayment.mockResolvedValue({
        providerPaymentId: 'pay-1',
        status: 'approved',
        amountArs: 1000,
        refundedAmountArs: 0,
      });

      expect(await service.reconcileRefunds(NOW)).toEqual({
        confirmed: 0,
        failed: 0,
      });
      expect(lifecycle.confirmRefund).not.toHaveBeenCalled();
    });

    it.each([
      ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED,
      ErrorCodes.MP_ACCOUNT_REVOKED,
      ErrorCodes.MP_NOT_LINKED,
    ])('token inservible (%s): marca el reembolso fallido', async (code) => {
      gateway.getPayment.mockRejectedValue(tokenError(code));

      const result = await service.reconcileRefunds(NOW);

      expect(lifecycle.markRefundFailedBySystem).toHaveBeenCalledWith(
        'r1',
        't-1',
        expect.stringContaining('Volvé a vincularla y reintentá el reembolso.'),
      );
      expect(result).toEqual({ confirmed: 0, failed: 1 });
    });

    it('otro error: lo deja pendiente y sigue con el resto del lote', async () => {
      prisma.reservation.findMany.mockResolvedValue(pendingRows('r1', 'r2'));
      gateway.getPayment
        .mockRejectedValueOnce(new Error('MP caído'))
        .mockResolvedValueOnce({
          providerPaymentId: 'pay-1',
          status: 'refunded',
          amountArs: 1000,
          refundedAmountArs: 1000,
        });

      const result = await service.reconcileRefunds(NOW);

      expect(lifecycle.markRefundFailedBySystem).not.toHaveBeenCalled();
      expect(lifecycle.confirmRefund).toHaveBeenCalledTimes(1);
      expect(result.confirmed).toBe(1);
    });

    it('sin fila de pago con id del proveedor: no consulta nada', async () => {
      prisma.reservationPayment.findFirst.mockResolvedValue(null);

      await service.reconcileRefunds(NOW);

      expect(gateway.getPayment).not.toHaveBeenCalled();
    });
  });
});
