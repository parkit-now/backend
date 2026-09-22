import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CashSessionsService } from './cash-sessions.service';

/** Structural view of a recorded mock, so these helpers need no jest types. */
type RecordedMock = { mock: { calls: unknown[][] } };

type FindManyArgs = {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
};

/** The arguments of the first call recorded on a mock. */
const firstCallOf = (fn: RecordedMock): FindManyArgs =>
  fn.mock.calls[0][0] as FindManyArgs;

describe('CashSessionsService', () => {
  let service: CashSessionsService;

  const mockTenant = {
    cashSession: { findMany: jest.fn() },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CashSessionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<CashSessionsService>(CashSessionsService);
    jest.clearAllMocks();
    mockPrisma.getTenantClient.mockReturnValue(mockTenant);
    mockTenant.cashSession.findMany.mockResolvedValue([]);
  });

  describe('listSessions', () => {
    it('returns the most recent shifts first, capped at `limit`', async () => {
      await service.listSessions({ limit: 5 });

      expect(firstCallOf(mockTenant.cashSession.findMany)).toEqual({
        where: {},
        orderBy: [{ openedAt: 'desc' }],
        take: 5,
      });
    });

    it('matches shifts by overlap, keeping one still running at `from`', async () => {
      await service.listSessions({
        from: '2026-09-01T00:00:00-03:00',
        to: '2026-09-08T00:00:00-03:00',
        limit: 100,
      });

      // Opened before the end, and either still open or closed after the start
      // — a shift that opened on Aug 31 and ran past midnight is included.
      expect(firstCallOf(mockTenant.cashSession.findMany).where).toEqual({
        openedAt: { lt: new Date('2026-09-08T03:00:00.000Z') },
        OR: [
          { closedAt: null },
          { closedAt: { gt: new Date('2026-09-01T03:00:00.000Z') } },
        ],
      });
    });

    it('rejects an inverted range without querying', async () => {
      const failure = await service
        .listSessions({
          from: '2026-09-08T00:00:00-03:00',
          to: '2026-09-01T00:00:00-03:00',
          limit: 100,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
      expect(mockTenant.cashSession.findMany).not.toHaveBeenCalled();
    });

    it('never threads tenantId through the filter', async () => {
      await service.listSessions({
        from: '2026-09-01T00:00:00-03:00',
        limit: 1,
      });

      // Isolation is the tenant-scoped client's job, not the service's.
      expect(
        firstCallOf(mockTenant.cashSession.findMany).where,
      ).not.toHaveProperty('tenantId');
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
    });

    it('returns money as numbers', async () => {
      mockTenant.cashSession.findMany.mockResolvedValue([
        {
          id: 'session-1',
          tenantId: 'tenant-1',
          openedAt: new Date('2026-09-07T11:00:00.000Z'),
          closedAt: null,
          openingCash: new Prisma.Decimal('1500.50'),
          leavingCash: null,
          notes: null,
          version: 1,
          syncSeq: 3,
          updatedAt: new Date('2026-09-07T11:00:00.000Z'),
        },
      ]);

      const [session] = await service.listSessions({ limit: 100 });

      expect(session.openingCash).toBe(1500.5);
      expect(session.leavingCash).toBeNull();
    });
  });
});

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
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: activeEntries.length }),
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
      openNextSession: true,
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
      openNextSession: true,
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
      await service.closeSession(SESSION, {
        openNextSession: true,
        newSessionId: NEW_SESSION,
      });
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

    await service.closeSession(SESSION, {
      openNextSession: true,
      newSessionId: NEW_SESSION,
    });

    const closeArg = tx.cashSession.update.mock.calls[0][0] as {
      data: { leavingCash: number };
    };
    const createArg = tx.cashSession.create.mock.calls[0][0] as {
      data: { openingCash: number };
    };
    expect(closeArg.data.leavingCash).toBe(0);
    expect(createArg.data.openingCash).toBe(0);
  });

  it('cierra la caja sin abrir otra por defecto', async () => {
    const { service, tx } = makeService([]);

    const result = await service.closeSession(SESSION, {
      closedAt: CLOSED_AT,
      leavingCash: 5000,
    });

    const closeArg = tx.cashSession.update.mock.calls[0][0] as {
      data: { closedAt: Date; leavingCash: number };
    };
    expect(closeArg.data.closedAt).toEqual(new Date(CLOSED_AT));
    expect(closeArg.data.leavingCash).toBe(0);
    expect(tx.cashSession.create).not.toHaveBeenCalled();
    expect(result.newSession).toBeNull();
    expect(result.carriedOverCount).toBe(0);
  });

  it('desasocia los autos activos si no se abre el siguiente turno', async () => {
    const { service, tx } = makeService([{ id: 'e-a' }, { id: 'e-b' }]);

    await service.closeSession(SESSION, {});

    expect(tx.entry.update).not.toHaveBeenCalled();
    expect(tx.entry.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, cashSessionId: SESSION, leftAt: null },
      data: { cashSessionId: null, ticketNumber: null },
    });
  });
});
