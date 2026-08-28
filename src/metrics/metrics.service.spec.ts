import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { MetricsService } from './metrics.service';
import { DEFAULT_TIME_ZONE, dayKeyIn, shiftDayKey } from './metrics-tz';

/** Half-open instant window, as the service builds it for a civil day. */
type DateRange = { gte: Date; lt: Date };

/** The shape of every `where` the metrics service builds. */
type MetricsWhere = {
  leftAt?: DateRange | null;
  enteredAt?: DateRange;
  status?: string;
  archivedAt?: null;
};

type WhereArgs = { where: MetricsWhere };

/** Structural view of a recorded mock, so these helpers need no jest types. */
type RecordedMock = { mock: { calls: unknown[][] } };

/** The `where` clause of every call recorded on a mock, in call order. */
const wheresOf = (fn: RecordedMock): MetricsWhere[] =>
  fn.mock.calls.map((call) => (call[0] as WhereArgs).where);

describe('MetricsService', () => {
  let service: MetricsService;

  const mockTenant = {
    entry: {
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    service: {
      findMany: jest.fn(),
    },
    lprDetectionEvent: {
      count: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
    tenant: { findUnique: jest.fn() },
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  /** Civil days the summary will ask for, relative to whenever the suite runs. */
  const today = dayKeyIn(new Date(), DEFAULT_TIME_ZONE);
  const yesterday = shiftDayKey(today, -1);
  const lastWeek = shiftDayKey(today, -7);

  /**
   * Wires the day-scoped queries to per-day fixtures. Ranges arrive as UTC
   * instants pinned to local midnight, so the range start maps back to its day
   * key — which is exactly how the assertions address each day.
   */
  const seedDays = (
    fixtures: Record<string, { revenue: number; in: number; out: number }>,
  ): void => {
    const dayOf = (range?: DateRange | null) =>
      range ? dayKeyIn(range.gte, DEFAULT_TIME_ZONE) : '';

    mockTenant.entry.aggregate.mockImplementation(({ where }: WhereArgs) => {
      const day = fixtures[dayOf(where.leftAt)] ?? {
        revenue: 0,
        in: 0,
        out: 0,
      };
      return Promise.resolve({
        _sum: { amountPaid: new Prisma.Decimal(day.revenue) },
        _count: day.out,
      });
    });

    mockTenant.entry.count.mockImplementation(({ where }: WhereArgs) => {
      // Occupancy asks for open entries; day totals ask for an enteredAt window.
      if (where.leftAt === null) return Promise.resolve(63);
      return Promise.resolve(fixtures[dayOf(where.enteredAt)]?.in ?? 0);
    });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
    jest.clearAllMocks();

    // Sensible defaults; individual tests override what they care about.
    mockPrisma.getTenantClient.mockReturnValue(mockTenant);
    mockTenant.service.findMany.mockResolvedValue([{ spots: 100 }]);
    mockTenant.entry.groupBy.mockResolvedValue([]);
    mockTenant.lprDetectionEvent.count.mockResolvedValue(0);
    mockPrisma.tenant.findUnique.mockResolvedValue({ settings: {} });
    seedDays({});
  });

  describe('getOccupancy', () => {
    it('derives capacity from enabled services', async () => {
      mockTenant.service.findMany.mockResolvedValue([
        { spots: 80 },
        { spots: 20 },
      ]);

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(100);
      expect(result.capacitySource).toBe('services');
      expect(result.occupied).toBe(63);
      expect(result.free).toBe(37);
      expect(result.occupancyPct).toBe(0.63);
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { enabled: true } }),
      );
    });

    it('falls back to the profile capacity when no service declares spots', async () => {
      mockTenant.service.findMany.mockResolvedValue([]);
      mockPrisma.tenant.findUnique.mockResolvedValue({
        settings: {
          capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 0 },
        },
      });

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(50);
      expect(result.capacitySource).toBe('settings');
    });

    it('reports an unknown capacity rather than a fake 0%', async () => {
      mockTenant.service.findMany.mockResolvedValue([]);
      mockPrisma.tenant.findUnique.mockResolvedValue({ settings: {} });

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(0);
      expect(result.capacitySource).toBe('none');
      expect(result.occupancyPct).toBeNull();
      expect(result.free).toBeNull();
    });

    it('floors free spots at zero when the lot is overbooked', async () => {
      mockTenant.service.findMany.mockResolvedValue([{ spots: 50 }]);

      const result = await service.getOccupancy();

      expect(result.occupied).toBe(63);
      expect(result.free).toBe(0);
      expect(result.occupancyPct).toBeGreaterThan(1);
    });

    it('labels undeclared vehicle types as unknown, most occupied first', async () => {
      mockTenant.entry.groupBy.mockResolvedValue([
        { vehicleType: 'moto', _count: { _all: 13 } },
        { vehicleType: null, _count: { _all: 40 } },
        { vehicleType: 'auto', _count: { _all: 10 } },
      ]);

      const result = await service.getOccupancy();

      expect(result.byVehicleType).toEqual([
        { type: 'unknown', occupied: 40 },
        { type: 'moto', occupied: 13 },
        { type: 'auto', occupied: 10 },
      ]);
    });
  });

  describe('getSummary', () => {
    it('returns today totals with both baselines and their deltas', async () => {
      seedDays({
        [today]: { revenue: 184500, in: 71, out: 63 },
        [yesterday]: { revenue: 160000, in: 65, out: 60 },
        [lastWeek]: { revenue: 210000, in: 80, out: 78 },
      });
      mockTenant.lprDetectionEvent.count.mockResolvedValue(4);

      const result = await service.getSummary({});

      expect(result.tz).toBe(DEFAULT_TIME_ZONE);
      expect(result.day).toBe(today);
      expect(result.today).toEqual({
        day: today,
        revenue: 184500,
        vehiclesIn: 71,
        vehiclesOut: 63,
      });
      expect(result.comparison.previousDay.day).toBe(yesterday);
      expect(result.comparison.previousDay.revenueDeltaPct).toBe(0.1531);
      expect(result.comparison.previousWeek.day).toBe(lastWeek);
      expect(result.comparison.previousWeek.revenueDeltaPct).toBe(-0.1214);
      expect(result.alerts).toEqual({ pendingLprEvents: 4 });
    });

    it('reports a null delta instead of dividing by zero', async () => {
      seedDays({
        [today]: { revenue: 5000, in: 3, out: 2 },
        [yesterday]: { revenue: 0, in: 0, out: 0 },
      });

      const result = await service.getSummary({});

      expect(result.comparison.previousDay.revenueDeltaPct).toBeNull();
      expect(result.comparison.previousDay.vehiclesInDeltaPct).toBeNull();
    });

    it('truncates each baseline to the elapsed slice of today', async () => {
      await service.getSummary({});

      const windows = wheresOf(mockTenant.entry.aggregate).map(
        (where) => where.leftAt as DateRange,
      );

      expect(windows).toHaveLength(3);
      const durations = windows.map((w) => w.lt.getTime() - w.gte.getTime());
      // A full-day baseline against today-so-far would fake a slump all morning.
      expect(new Set(durations).size).toBe(1);
      expect(durations[0]).toBeLessThanOrEqual(86_400_000);
    });

    it('honours an explicit timezone', async () => {
      const result = await service.getSummary({ tz: 'UTC' });

      expect(result.tz).toBe('UTC');
      expect(result.day).toBe(dayKeyIn(new Date(), 'UTC'));
    });

    it('counts only unreviewed, non-archived detections as alerts', async () => {
      await service.getSummary({});

      expect(mockTenant.lprDetectionEvent.count).toHaveBeenCalledWith({
        where: { status: 'pending', archivedAt: null },
      });
    });

    it('never threads tenantId through the query filters', async () => {
      await service.getSummary({});

      const everyWhere = [
        ...wheresOf(mockTenant.entry.aggregate),
        ...wheresOf(mockTenant.entry.count),
        ...wheresOf(mockTenant.lprDetectionEvent.count),
      ];

      // Isolation is the tenant-scoped client's job, not the service's.
      for (const where of everyWhere) {
        expect(where).not.toHaveProperty('tenantId');
      }
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
    });
  });
});
