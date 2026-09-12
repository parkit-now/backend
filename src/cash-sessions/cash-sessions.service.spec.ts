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
