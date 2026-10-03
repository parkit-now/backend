import { PrismaService } from '../database/prisma.service';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationSweeperService } from './reservation-sweeper.service';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-28T12:00:00');
const minutes = (base: Date, delta: number) =>
  new Date(base.getTime() + delta * 60_000);

const prisma = { reservation: { findMany: jest.fn() } };
const lifecycle = {
  expireHold: jest.fn(),
  rejectByTimeout: jest.fn(),
  markNoShow: jest.fn(),
};

const service = new ReservationSweeperService(
  prisma as unknown as PrismaService,
  lifecycle as unknown as ReservationLifecycleService,
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
});
