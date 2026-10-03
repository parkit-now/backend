import type { Prisma } from '@prisma/client';
import { holdingWhere, lockAndCheckCapacity } from './reservation-capacity';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');
const TENANT = '11111111-1111-4111-8111-111111111111';

const tx = {
  $executeRaw: jest.fn(),
  reservation: { findMany: jest.fn() },
};
const client = tx as unknown as Prisma.TransactionClient;

const window = {
  entryAt: ar('2026-09-28T10:00:00'),
  exitAt: ar('2026-09-28T12:00:00'),
};
const booked = (from: string, to: string) => ({
  entryAt: ar(`2026-09-28T${from}:00`),
  exitAt: ar(`2026-09-28T${to}:00`),
});

describe('holdingWhere', () => {
  it('toma los estados que retienen y la pending_payment con retención + 5 min', () => {
    expect(holdingWhere(NOW)).toEqual({
      OR: [
        { status: { in: ['pending_approval', 'confirmed', 'checked_in'] } },
        {
          status: 'pending_payment',
          holdExpiresAt: { gt: new Date(NOW.getTime() - 5 * 60_000) },
        },
      ],
    });
  });
});

describe('lockAndCheckCapacity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tx.reservation.findMany.mockResolvedValue([]);
  });

  it('toma el lock de la playa y consulta las reservas que se superponen', async () => {
    await lockAndCheckCapacity(client, TENANT, window, 2, NOW);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.reservation.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        ...holdingWhere(NOW),
        entryAt: { lt: window.exitAt },
        exitAt: { gt: window.entryAt },
      },
      select: { entryAt: true, exitAt: true },
    });
  });

  it('hay lugar si el pico está por debajo del cupo', async () => {
    tx.reservation.findMany.mockResolvedValue([booked('09:00', '11:00')]);
    expect(await lockAndCheckCapacity(client, TENANT, window, 2, NOW)).toBe(
      true,
    );
  });

  it('no hay lugar si el pico alcanza el cupo', async () => {
    tx.reservation.findMany.mockResolvedValue([
      booked('09:00', '11:00'),
      booked('10:30', '13:00'),
    ]);
    expect(await lockAndCheckCapacity(client, TENANT, window, 2, NOW)).toBe(
      false,
    );
  });

  it('con cupo 0 nunca hay lugar', async () => {
    expect(await lockAndCheckCapacity(client, TENANT, window, 0, NOW)).toBe(
      false,
    );
  });

  it('excluye a la reserva indicada del conteo', async () => {
    await lockAndCheckCapacity(client, TENANT, window, 1, NOW, 'res-1');
    const [args] = tx.reservation.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where.id).toEqual({ not: 'res-1' });
  });
});
