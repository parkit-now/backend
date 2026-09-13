import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CashSessionsService } from './cash-sessions.service';

describe('CashSessionsService.closeSession', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const SESSION = '22222222-2222-7222-8222-222222222222';
  const NEW_SESSION = '33333333-3333-7333-8333-333333333333';
  const CLOSED_AT = '2026-09-12T20:00:00.000Z';

  function row(overrides: Record<string, unknown> = {}) {
    const now = new Date(CLOSED_AT);
    return {
      id: SESSION,
      tenantId: TENANT,
      openedAt: now,
      closedAt: null,
      openingCash: 0,
      leavingCash: null,
      notes: null,
      version: 1,
      syncSeq: 1,
      updatedAt: now,
      ...overrides,
    };
  }

  /**
   * @param activeEntries las entries que el SERVIDOR ve activas en la caja,
   * ya ordenadas por `enteredAt` como hace el `findMany` real.
   */
  function makeService(
    activeEntries: { id: string }[],
    existing: Record<string, unknown> | null = row(),
  ) {
    const tx = {
      cashSession: {
        update: jest
          .fn()
          .mockResolvedValue(row({ closedAt: new Date(CLOSED_AT) })),
        create: jest
          .fn()
          .mockResolvedValue(row({ id: NEW_SESSION, closedAt: null })),
      },
      entry: {
        findMany: jest.fn().mockResolvedValue(activeEntries),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    const tenantPrisma = {
      cashSession: { findFirst: jest.fn().mockResolvedValue(existing) },
    };

    const prisma = {
      getTenantClient: jest.fn().mockReturnValue(tenantPrisma),
      $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
    };

    const tenantContext = { getTenantIdOrThrow: () => TENANT };

    return {
      tx,
      tenantPrisma,
      service: new CashSessionsService(
        prisma as unknown as PrismaService,
        tenantContext as unknown as TenantContextService,
      ),
    };
  }

  /** `{ entryId -> ticketNumber }` de lo que realmente se escribió. */
  function ticketsWritten(tx: ReturnType<typeof makeService>['tx']) {
    return Object.fromEntries(
      tx.entry.update.mock.calls.map((call) => {
        const arg = call[0] as {
          where: { id: string };
          data: { ticketNumber: number; cashSessionId: string };
        };
        return [arg.where.id, arg.data.ticketNumber];
      }),
    );
  }

  it('cierra la caja y abre la nueva con el efectivo que queda', async () => {
    const { service, tx } = makeService([]);

    const result = await service.closeSession(SESSION, {
      newSessionId: NEW_SESSION,
      closedAt: CLOSED_AT,
      leavingCash: 5000,
    });

    const closeArg = tx.cashSession.update.mock.calls[0][0] as {
      data: { closedAt: Date; leavingCash: number };
    };
    expect(closeArg.data.leavingCash).toBe(5000);
    expect(closeArg.data.closedAt).toEqual(new Date(CLOSED_AT));

    const createArg = tx.cashSession.create.mock.calls[0][0] as {
      data: { id: string; openedAt: Date; openingCash: number };
    };
    // La caja nueva abre en el MISMO instante en que cerró la vieja: si
    // hubiera hueco, un ingreso registrado en el medio quedaría sin caja.
    expect(createArg.data.id).toBe(NEW_SESSION);
    expect(createArg.data.openedAt).toEqual(new Date(CLOSED_AT));
    expect(createArg.data.openingCash).toBe(5000);

    expect(result.carriedOverCount).toBe(0);
  });

  it('traspasa los autos que siguen adentro renumerando 1..N', async () => {
    const { service, tx } = makeService([
      { id: 'e-a' },
      { id: 'e-b' },
      { id: 'e-c' },
    ]);

    const result = await service.closeSession(SESSION, {
      newSessionId: NEW_SESSION,
    });

    expect(ticketsWritten(tx)).toEqual({ 'e-a': 1, 'e-b': 2, 'e-c': 3 });
    expect(result.carriedOverCount).toBe(3);

    const first = tx.entry.update.mock.calls[0][0] as {
      data: { cashSessionId: string };
    };
    expect(first.data.cashSessionId).toBe(NEW_SESSION);
  });

  it('rechaza cerrar una caja ya cerrada o inexistente', async () => {
    // `closeSession` no tiene `expectedVersion`: su única guarda es
    // `closedAt: null`. O sea que un doble envío (doble click, retry de red)
    // cae acá, y lo importante es que NO haga nada a medias: si llegara a
    // crear la caja nueva chocaría contra el índice único de "una caja
    // abierta por estacionamiento".
    const { service, tx } = makeService([], null);

    let caught: unknown;
    try {
      await service.closeSession(SESSION, { newSessionId: NEW_SESSION });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const response = (
      caught as { getResponse: () => { status: number; detail: string } }
    ).getResponse();
    expect(response.status).toBe(404);
    expect(response.detail).toContain('already closed');
    // Y sobre todo: no tocó nada.
    expect(tx.cashSession.update).not.toHaveBeenCalled();
    expect(tx.cashSession.create).not.toHaveBeenCalled();
  });

  it('defaultea leavingCash a 0 cuando no se manda', async () => {
    const { service, tx } = makeService([]);

    await service.closeSession(SESSION, { newSessionId: NEW_SESSION });

    const closeArg = tx.cashSession.update.mock.calls[0][0] as {
      data: { leavingCash: number };
    };
    const createArg = tx.cashSession.create.mock.calls[0][0] as {
      data: { openingCash: number };
    };
    expect(closeArg.data.leavingCash).toBe(0);
    expect(createArg.data.openingCash).toBe(0);
  });
});
