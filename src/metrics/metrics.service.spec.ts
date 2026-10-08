import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
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
  vehicleType?: string;
  vehicleCategory?: string;
  paymentMethodName?: string;
  // Transactions carry no timestamp, so their window rides on the relation.
  entry?: { leftAt?: DateRange; tenantId?: string };
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
      findMany: jest.fn(),
    },
    paymentTransaction: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
    // No `service` mock on purpose: capacity no longer reads `services.spots`,
    // so a regression that brought the query back would fail loudly here.
    lprDetectionEvent: {
      count: jest.fn(),
    },
    cashSession: {
      findFirst: jest.fn(),
    },
    reservation: {
      findMany: jest.fn(),
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
    mockTenant.entry.groupBy.mockResolvedValue([]);
    mockTenant.entry.findMany.mockResolvedValue([]);
    mockTenant.paymentTransaction.findMany.mockResolvedValue([]);
    mockTenant.paymentTransaction.groupBy.mockResolvedValue([]);
    mockTenant.lprDetectionEvent.count.mockResolvedValue(0);
    mockTenant.reservation.findMany.mockResolvedValue([]);
    mockPrisma.tenant.findUnique.mockResolvedValue({
      settings: { capacity: { total: 100 } },
    });
    seedDays({});
  });

  describe('getOccupancy', () => {
    it('derives capacity from the profile total', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue({
        settings: { capacity: { total: 100 } },
      });

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(100);
      expect(result.occupied).toBe(63);
      expect(result.free).toBe(37);
      expect(result.occupancyPct).toBe(0.63);
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(wheresOf(mockTenant.entry.count)[0]).toMatchObject({
        leftAt: null,
        deletedAt: null,
      });
      expect(wheresOf(mockTenant.entry.groupBy)[0]).toMatchObject({
        leftAt: null,
        deletedAt: null,
      });
    });

    it('reservedHeld: las reservas de hoy sin ingreso retienen lugar y bajan los libres', async () => {
      const inOneHour = new Date(Date.now() + 60 * 60_000);
      mockTenant.reservation.findMany.mockResolvedValue([
        {
          entryAt: inOneHour,
          status: 'confirmed',
          holdExpiresAt: null,
          policySnapshot: null,
        },
        {
          entryAt: inOneHour,
          status: 'pending_approval',
          holdExpiresAt: null,
          policySnapshot: null,
        },
      ]);

      const result = await service.getOccupancy();

      // Si la hora +1 cae mañana (corrida cerca de medianoche) no es de hoy.
      const sameDay =
        dayKeyIn(inOneHour, DEFAULT_TIME_ZONE) ===
        dayKeyIn(new Date(), DEFAULT_TIME_ZONE);
      const held = sameDay ? 2 : 0;
      expect(result.reservedHeld).toBe(held);
      expect(result.free).toBe(100 - 63 - held);
      // La ocupación sigue siendo la de los autos adentro.
      expect(result.occupancyPct).toBe(0.63);
    });

    it('sin doble conteo: una reserva checked_in no retiene (la cuenta su ingreso)', async () => {
      mockTenant.reservation.findMany.mockResolvedValue([
        {
          entryAt: new Date(),
          status: 'checked_in',
          holdExpiresAt: null,
          policySnapshot: null,
        },
      ]);

      const result = await service.getOccupancy();

      expect(result.reservedHeld).toBe(0);
      expect(result.free).toBe(37);
      const where = JSON.stringify(
        (mockTenant.reservation.findMany.mock.calls[0][0] as { where: unknown })
          .where,
      );
      expect(where).toContain('"not":"checked_in"');
    });

    it('sums the legacy per-type capacity written before the migration', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue({
        settings: {
          capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 0 },
        },
      });

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(50);
    });

    it('reports an unknown capacity rather than a fake 0%', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue({ settings: {} });

      const result = await service.getOccupancy();

      expect(result.capacity).toBe(0);
      expect(result.occupancyPct).toBeNull();
      expect(result.free).toBeNull();
    });

    it('floors free spots at zero when the lot is overbooked', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue({
        settings: { capacity: { total: 50 } },
      });

      const result = await service.getOccupancy();

      expect(result.occupied).toBe(63);
      expect(result.free).toBe(0);
      expect(result.occupancyPct).toBeGreaterThan(1);
    });

    it('labels undeclared vehicle types as unknown, most occupied first', async () => {
      mockTenant.entry.groupBy.mockResolvedValue([
        { vehicleType: 'Moto', _count: { _all: 13 } },
        { vehicleType: null, _count: { _all: 40 } },
        { vehicleType: 'Auto', _count: { _all: 10 } },
      ]);

      const result = await service.getOccupancy();

      expect(result.byVehicleType).toEqual([
        { type: 'unknown', occupied: 40 },
        { type: 'Moto', occupied: 13 },
        { type: 'Auto', occupied: 10 },
      ]);
    });

    it('groups the open entries by vehicle category, with "Sin dato" (null) last', async () => {
      mockTenant.entry.groupBy.mockImplementation(({ by }: { by: string[] }) =>
        Promise.resolve(
          by[0] === 'vehicleCategory'
            ? [
                { vehicleCategory: null, _count: { _all: 40 } },
                { vehicleCategory: 'motorcycle', _count: { _all: 13 } },
                { vehicleCategory: 'car', _count: { _all: 20 } },
              ]
            : [],
        ),
      );

      const result = await service.getOccupancy();

      expect(result.byVehicleCategory).toEqual([
        { category: 'car', occupied: 20 },
        { category: 'motorcycle', occupied: 13 },
        // The absence of an answer is not ranked, even when it is the biggest.
        { category: null, occupied: 40 },
      ]);
    });

    it('a category outside the closed list reads as null instead of leaking', async () => {
      mockTenant.entry.groupBy.mockImplementation(({ by }: { by: string[] }) =>
        Promise.resolve(
          by[0] === 'vehicleCategory'
            ? [{ vehicleCategory: 'monopatin', _count: { _all: 2 } }]
            : [],
        ),
      );

      const result = await service.getOccupancy();

      expect(result.byVehicleCategory).toEqual([
        { category: null, occupied: 2 },
      ]);
    });
  });

  describe('getRevenue', () => {
    const AR_OFFSET = '-03:00';
    const range = {
      from: `2026-08-07T13:00:00${AR_OFFSET}`,
      to: `2026-08-10T13:00:00${AR_OFFSET}`,
    };

    /** Closed stays, as the service selects them (id + leftAt + amountPaid). */
    const exits = (rows: [string, number][]) =>
      rows.map(([leftAt, amount], i) => ({
        id: `e${i}`,
        leftAt: new Date(leftAt),
        amountPaid: new Prisma.Decimal(amount),
      }));

    it('buckets revenue by civil day in the requested timezone', async () => {
      mockTenant.entry.findMany
        .mockResolvedValueOnce(
          exits([
            ['2026-08-07T16:00:00Z', 1000], // 13:00 AR del 7
            ['2026-08-08T16:00:00Z', 500], // 13:00 AR del 8
            ['2026-08-08T20:00:00Z', 250], // 17:00 AR del 8
          ]),
        )
        .mockResolvedValueOnce([]);

      const result = await service.getRevenue(range);

      expect(result.granularity).toBe('day');
      expect(result.revenueSource).toBe('entries');
      expect(result.currency).toBe('ARS');
      expect(result.buckets.map((b) => [b.key, b.revenue])).toEqual([
        ['2026-08-07', 1000],
        ['2026-08-08', 750],
        ['2026-08-09', 0],
        ['2026-08-10', 0],
      ]);
      expect(result.totals.revenue).toBe(1750);
      expect(result.totals.vehiclesOut).toBe(3);
      expect(wheresOf(mockTenant.entry.findMany)[0]).toMatchObject({
        deletedAt: null,
      });
    });

    it('clips the edge buckets to the requested instants', async () => {
      mockTenant.entry.findMany.mockResolvedValue([]);

      const result = await service.getRevenue(range);

      // Window starts 13:00 AR on the 7th, not midnight.
      expect(result.buckets[0].from.toISOString()).toBe(
        '2026-08-07T16:00:00.000Z',
      );
      expect(result.buckets[0].to.toISOString()).toBe(
        '2026-08-08T03:00:00.000Z',
      );
      const last = result.buckets[result.buckets.length - 1];
      expect(last.to.toISOString()).toBe('2026-08-10T16:00:00.000Z');
    });

    it('anchors money on exit and vehicle counts on arrival', async () => {
      // One stay: arrives on the 7th, leaves on the 9th.
      mockTenant.entry.findMany
        .mockResolvedValueOnce(exits([['2026-08-09T16:00:00Z', 3000]]))
        .mockResolvedValueOnce([
          { enteredAt: new Date('2026-08-07T16:00:00Z') },
        ]);

      const result = await service.getRevenue(range);
      const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b]));

      // The visit counts on the 7th...
      expect(byKey['2026-08-07'].vehiclesIn).toBe(1);
      expect(byKey['2026-08-07'].revenue).toBe(0);
      // ...and the money on the 9th.
      expect(byKey['2026-08-09'].revenue).toBe(3000);
      expect(byKey['2026-08-09'].vehiclesIn).toBe(0);
      expect(byKey['2026-08-09'].vehiclesOut).toBe(1);
    });

    it('switches source to transactions when filtering by payment method', async () => {
      mockTenant.paymentTransaction.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal(700),
          entryId: 'e1',
          entry: { leftAt: new Date('2026-08-07T16:00:00Z') },
        },
      ]);

      const result = await service.getRevenue({
        ...range,
        paymentMethod: 'Efectivo',
      });

      expect(result.revenueSource).toBe('paymentTransactions');
      expect(result.totals.revenue).toBe(700);
      expect(mockTenant.entry.findMany).toHaveBeenCalledTimes(1); // arrivals only
      const where = wheresOf(mockTenant.paymentTransaction.findMany)[0];
      expect(where.paymentMethodName).toBe('Efectivo');
      // Range is applied through the relation, since transactions have no
      // timestamp of their own.
      expect(where.entry?.leftAt).toBeDefined();
      // ...and the relation restates the tenant, which the client extension
      // only injects at the top level. Without it Postgres cannot use the
      // (tenant_id, left_at) index and full-scans `entries`.
      expect(where.entry?.tenantId).toBe('tenant-1');
    });

    it('counts a stay once even when it splits across several transactions', async () => {
      mockTenant.paymentTransaction.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal(400),
          entryId: 'same-entry',
          entry: { leftAt: new Date('2026-08-07T16:00:00Z') },
        },
        {
          amount: new Prisma.Decimal(600),
          entryId: 'same-entry',
          entry: { leftAt: new Date('2026-08-07T16:00:00Z') },
        },
      ]);

      const result = await service.getRevenue({
        ...range,
        paymentMethod: 'Efectivo',
      });

      expect(result.totals.revenue).toBe(1000);
      expect(result.totals.vehiclesOut).toBe(1);
    });

    it('passes the vehicle type filter through to every series', async () => {
      await service.getRevenue({ ...range, vehicleType: 'Moto' });

      const wheres = wheresOf(mockTenant.entry.findMany);
      expect(wheres).toHaveLength(3); // exits + arrivals + reservation prepaid
      for (const where of wheres) {
        // Matched verbatim against the snapshot, not resolved through the
        // tenant's live `vehicle_types` catalogue.
        expect(where.vehicleType).toBe('Moto');
      }
    });

    it('passes the vehicle category filter through to every series', async () => {
      await service.getRevenue({ ...range, vehicleCategory: 'suv' });

      const wheres = wheresOf(mockTenant.entry.findMany);
      expect(wheres).toHaveLength(3); // exits + arrivals + reservation prepaid
      for (const where of wheres) {
        expect(where.vehicleCategory).toBe('suv');
        // The deprecated filter is not invented when it was not sent.
        expect(where).not.toHaveProperty('vehicleType');
      }
    });

    it('combines both filters when both are sent', async () => {
      await service.getRevenue({
        ...range,
        vehicleCategory: 'suv',
        vehicleType: 'SUV',
      });

      for (const where of wheresOf(mockTenant.entry.findMany)) {
        expect(where).toMatchObject({
          vehicleCategory: 'suv',
          vehicleType: 'SUV',
        });
      }
    });

    it('rejects an inverted range', async () => {
      const failure = await service
        .getRevenue({ from: range.to, to: range.from })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
    });

    it('rejects a range that would explode into too many buckets', async () => {
      const failure = await service
        .getRevenue({
          from: `2020-01-01T00:00:00${AR_OFFSET}`,
          to: `2026-01-01T00:00:00${AR_OFFSET}`,
          granularity: 'hour',
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
    });

    it('supports hourly granularity', async () => {
      mockTenant.entry.findMany
        .mockResolvedValueOnce(exits([['2026-08-07T17:30:00Z', 900]]))
        .mockResolvedValueOnce([]);

      const result = await service.getRevenue({
        from: `2026-08-07T13:00:00${AR_OFFSET}`,
        to: `2026-08-07T16:00:00${AR_OFFSET}`,
        granularity: 'hour',
      });

      expect(result.buckets.map((b) => b.key)).toEqual([
        '2026-08-07T13',
        '2026-08-07T14',
        '2026-08-07T15',
      ]);
      expect(result.buckets[1].revenue).toBe(900); // 14:30 AR
    });

    it('never threads tenantId through the revenue filters', async () => {
      await service.getRevenue(range);

      for (const call of mockTenant.entry.findMany.mock.calls) {
        const [args] = call as [{ where: Record<string, any> }];
        expect(args.where).not.toHaveProperty('tenantId');
      }
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
    });
  });

  describe('getVehicleCategoryBreakdown', () => {
    const range = {
      from: '2026-08-07T13:00:00-03:00',
      to: '2026-08-10T13:00:00-03:00',
    };

    it('splits the stays that ended in the window by category, "Sin dato" last', async () => {
      mockTenant.entry.groupBy.mockResolvedValue([
        {
          vehicleCategory: null,
          _count: { _all: 6 },
          _sum: { amountPaid: new Prisma.Decimal(900) },
        },
        {
          vehicleCategory: 'car',
          _count: { _all: 3 },
          _sum: { amountPaid: new Prisma.Decimal(3000) },
        },
        {
          vehicleCategory: 'motorcycle',
          _count: { _all: 1 },
          _sum: { amountPaid: new Prisma.Decimal(500) },
        },
      ]);

      const result = await service.getVehicleCategoryBreakdown(range);

      expect(result.totalStays).toBe(10);
      expect(result.totalRevenue).toBe(4400);
      expect(result.categories).toEqual([
        { category: 'car', stays: 3, revenue: 3000, share: 0.3 },
        { category: 'motorcycle', stays: 1, revenue: 500, share: 0.1 },
        { category: null, stays: 6, revenue: 900, share: 0.6 },
      ]);
      // Shares of every slice add up to the whole.
      const shares = result.categories.reduce((s, c) => s + (c.share ?? 0), 0);
      expect(shares).toBeCloseTo(1);
    });

    it('adds a "reservation_unused" slice for no-show money so the total matches by-payment-method', async () => {
      mockTenant.entry.groupBy.mockResolvedValue([
        {
          vehicleCategory: 'car',
          _count: { _all: 2 },
          _sum: {
            amountPaid: new Prisma.Decimal(1000),
            prepaidAmountArs: new Prisma.Decimal(500),
          },
        },
      ]);
      mockTenant.reservation.findMany.mockResolvedValue([
        {
          status: 'no_show',
          entryAt: new Date('2026-08-08T12:00:00Z'),
          cancelledAt: null,
          totalArs: new Prisma.Decimal(5000),
          paidAt: new Date('2026-08-06T12:00:00Z'),
          refundStatus: 'none',
          refundedAmountArs: null,
          refundRequestedArs: null,
          payments: [{ amountArs: new Prisma.Decimal(5000) }],
        },
      ]);

      const result = await service.getVehicleCategoryBreakdown(range);

      expect(result.totalStays).toBe(2);
      expect(result.totalRevenue).toBe(6500);
      expect(result.categories).toEqual([
        { category: 'car', stays: 2, revenue: 1500, share: 1 },
        { category: 'reservation_unused', stays: 0, revenue: 5000, share: 0 },
      ]);
    });

    it('omits the slice when there is no unused reservation money', async () => {
      const none = await service.getVehicleCategoryBreakdown(range);
      expect(none.categories).toEqual([]);
    });

    it('groups by the frozen category over the ended-in-window stays', async () => {
      await service.getVehicleCategoryBreakdown({
        ...range,
        vehicleCategory: 'car',
      });

      const [call] = mockTenant.entry.groupBy.mock.calls as [
        [{ by: string[]; where: MetricsWhere }],
      ];
      expect(call[0].by).toEqual(['vehicleCategory']);
      expect(call[0].where.leftAt).toEqual({
        gte: new Date(range.from),
        lt: new Date(range.to),
      });
      expect(call[0].where.vehicleCategory).toBe('car');
    });

    it('an empty window gives no slices and a null share, not a division by zero', async () => {
      const result = await service.getVehicleCategoryBreakdown(range);

      expect(result).toMatchObject({
        totalStays: 0,
        totalRevenue: 0,
        categories: [],
      });
    });

    it('rejects an inverted window', async () => {
      const failure = await service
        .getVehicleCategoryBreakdown({ from: range.to, to: range.from })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
    });
  });

  describe('getPaymentMethodBreakdown', () => {
    const range = {
      from: '2026-08-07T13:00:00-03:00',
      to: '2026-08-10T13:00:00-03:00',
    };

    const slice = (name: string, amount: number, count: number) => ({
      paymentMethodName: name,
      _sum: { amount: new Prisma.Decimal(amount) },
      _count: { _all: count },
    });

    const totalOf = (amount: number) =>
      mockTenant.entry.aggregate.mockResolvedValue({
        _sum: { amountPaid: new Prisma.Decimal(amount) },
      });

    it('splits revenue by method, largest slice first', async () => {
      totalOf(3000);
      mockTenant.paymentTransaction.groupBy.mockResolvedValue([
        slice('Transferencia', 800, 1),
        slice('Efectivo', 2200, 3),
      ]);

      const result = await service.getPaymentMethodBreakdown(range);

      expect(result.methods.map((m) => m.name)).toEqual([
        'Efectivo',
        'Transferencia',
      ]);
      expect(result.methods[0]).toEqual({
        name: 'Efectivo',
        kind: 'payment',
        amount: 2200,
        count: 3,
        share: 0.7333,
      });
      expect(result.total).toBe(3000);
      expect(result.allocated).toBe(3000);
      expect(result.unallocated).toBe(0);
    });

    it('reports the gap when stays were closed without itemised payments', async () => {
      // The offline fallback: amountPaid recorded, no transaction rows.
      totalOf(5000);
      mockTenant.paymentTransaction.groupBy.mockResolvedValue([
        slice('Efectivo', 2000, 2),
      ]);

      const result = await service.getPaymentMethodBreakdown(range);

      expect(result.total).toBe(5000);
      expect(result.allocated).toBe(2000);
      expect(result.unallocated).toBe(3000);
      // Slices plus the gap still account for the whole KPI.
      expect(result.methods[0].share).toBe(0.4);
    });

    it('leaves shares null rather than dividing by an empty window', async () => {
      totalOf(0);
      mockTenant.paymentTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getPaymentMethodBreakdown(range);

      expect(result.total).toBe(0);
      expect(result.unallocated).toBe(0);
      expect(result.methods).toEqual([]);
    });

    it('scopes the transaction grouping through the entry relation', async () => {
      totalOf(0);

      await service.getPaymentMethodBreakdown(range);

      const where = wheresOf(mockTenant.paymentTransaction.groupBy)[0];
      expect(where.entry?.leftAt).toBeDefined();
      expect(where.entry?.tenantId).toBe('tenant-1');
    });

    it('rejects an inverted range', async () => {
      const failure = await service
        .getPaymentMethodBreakdown({ from: range.to, to: range.from })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
    });
  });

  describe('getTopPlates', () => {
    const range = {
      from: '2026-08-07T13:00:00-03:00',
      to: '2026-08-10T13:00:00-03:00',
    };

    /** [plate, amount, minutes parked] */
    const stays = (rows: [string, number, number][]) =>
      rows.map(([plate, amount, minutes]) => ({
        plate,
        enteredAt: new Date('2026-08-08T12:00:00Z'),
        leftAt: new Date(Date.parse('2026-08-08T12:00:00Z') + minutes * 60_000),
        amountPaid: new Prisma.Decimal(amount),
      }));

    it('aggregates every metric per plate', async () => {
      mockTenant.entry.findMany.mockResolvedValue(
        stays([
          ['AAA111', 1000, 60],
          ['AAA111', 2000, 120],
          ['BBB222', 5000, 30],
        ]),
      );

      const result = await service.getTopPlates(range);

      expect(result.items).toEqual([
        {
          plate: 'BBB222',
          revenue: 5000,
          visits: 1,
          totalMinutes: 30,
          averageMinutes: 30,
        },
        {
          plate: 'AAA111',
          revenue: 3000,
          visits: 2,
          totalMinutes: 180,
          averageMinutes: 90,
        },
      ]);
      expect(result.orderBy).toBe('revenue');
    });

    it('re-ranks by visits without changing the metrics', async () => {
      mockTenant.entry.findMany.mockResolvedValue(
        stays([
          ['AAA111', 1000, 60],
          ['AAA111', 2000, 120],
          ['BBB222', 5000, 30],
        ]),
      );

      const result = await service.getTopPlates({
        ...range,
        orderBy: 'visits',
      });

      expect(result.items.map((i) => i.plate)).toEqual(['AAA111', 'BBB222']);
      expect(result.items[0].revenue).toBe(3000);
    });

    it('re-ranks by time parked', async () => {
      mockTenant.entry.findMany.mockResolvedValue(
        stays([
          ['AAA111', 1000, 600],
          ['BBB222', 5000, 30],
        ]),
      );

      const result = await service.getTopPlates({
        ...range,
        orderBy: 'duration',
      });

      expect(result.items.map((i) => i.plate)).toEqual(['AAA111', 'BBB222']);
    });

    it('honours the limit', async () => {
      mockTenant.entry.findMany.mockResolvedValue(
        stays([
          ['AAA111', 3000, 60],
          ['BBB222', 2000, 60],
          ['CCC333', 1000, 60],
        ]),
      );

      const result = await service.getTopPlates({ ...range, limit: 2 });

      expect(result.items.map((i) => i.plate)).toEqual(['AAA111', 'BBB222']);
    });

    it('only considers stays that already ended', async () => {
      mockTenant.entry.findMany.mockResolvedValue([]);

      await service.getTopPlates(range);

      const where = wheresOf(mockTenant.entry.findMany)[0];
      expect(where.leftAt).toEqual({
        gte: new Date(range.from),
        lt: new Date(range.to),
      });
    });

    it('rejects an inverted range', async () => {
      const failure = await service
        .getTopPlates({ from: range.to, to: range.from })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
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
        reservationRevenue: 0,
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

      const durations = windows
        .slice(0, 3)
        .map((w) => w.lt.getTime() - w.gte.getTime());
      // A full-day baseline against today-so-far would fake a slump all morning.
      expect(new Set(durations).size).toBe(1);
      expect(durations[0]).toBeLessThanOrEqual(86_400_000);
    });

    it('adds active open-entry value to today and month projections', async () => {
      seedDays({
        [today]: { revenue: 5000, in: 3, out: 2 },
      });
      mockTenant.entry.findMany.mockImplementation(({ where }: WhereArgs) => {
        if (where.leftAt === null) {
          return Promise.resolve([
            {
              enteredAt: new Date(Date.now() - 70 * 60_000),
              rateSnapshotHourPriceArs: new Prisma.Decimal(1000),
              rateSnapshotStayPriceArs: new Prisma.Decimal(0),
              rateSnapshotFractionPriceArs: new Prisma.Decimal(100),
              rateSnapshotMediaEstadiaPriceArs: new Prisma.Decimal(0),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getSummary({});

      expect(result.projections.todayWithOpenEntries.openEntries).toBe(1);
      expect(result.projections.todayWithOpenEntries.value).toBeGreaterThan(
        result.today.revenue,
      );
      expect(result.projections.monthWithOpenEntries.value).toBeGreaterThan(0);
    });

    it('reports low confidence when trend history is missing', async () => {
      seedDays({
        [today]: { revenue: 5000, in: 3, out: 2 },
      });

      const result = await service.getSummary({});

      expect(result.projections.todayHistoricalForecast.historicalDays).toBe(0);
      expect(result.projections.todayHistoricalForecast.confidence).toBe('low');
      expect(result.projections.monthHistoricalForecast.confidence).toBe('low');
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

  describe('cash session filter', () => {
    /** UUIDv7, the version the desktop generates for its cash sessions. */
    const SESSION_ID = '0198f2a4-7c3e-7a1b-9d2e-4f5a6b7c8d9e';
    /** 06:00–14:00 in Argentina: one full shift. */
    const OPENED = new Date('2026-09-07T09:00:00.000Z');
    const CLOSED = new Date('2026-09-07T17:00:00.000Z');

    /** The Problem Details body a `FormattedException` carries. */
    const problem = (error: unknown) =>
      (error as FormattedException).getResponse() as {
        code: string;
        status: number;
      };

    /** `where` clauses seen loosely: these filters go beyond `MetricsWhere`. */
    type AnyWhere = Record<string, unknown>;
    const loose = (fn: RecordedMock): AnyWhere[] =>
      fn.mock.calls.map((call) => (call[0] as { where: AnyWhere }).where);

    /** The payment filter every entries-rooted query must use for a session. */
    const COLLECTED_BY_SESSION = {
      // `deletedAt: null` is not decoration: correcting a payment leaves a
      // tombstone row, and matching it would count the corrected stay twice.
      some: {
        cashSessionId: SESSION_ID,
        tenantId: 'tenant-1',
        deletedAt: null,
      },
    };

    /**
     * Answers the span query with the first and last payment of the session,
     * and any other aggregate with zeros.
     */
    const paidBetween = (first: Date | null, last: Date | null): void => {
      mockTenant.entry.aggregate.mockImplementation(
        (args: { _min?: unknown }) =>
          Promise.resolve(
            args._min
              ? { _min: { leftAt: first }, _max: { leftAt: last } }
              : { _sum: { amountPaid: new Prisma.Decimal(0) }, _count: 0 },
          ),
      );
    };

    beforeEach(() => {
      mockTenant.cashSession.findFirst.mockResolvedValue({
        id: SESSION_ID,
        openedAt: OPENED,
        closedAt: CLOSED,
      });
      paidBetween(null, null);
    });

    describe('window', () => {
      it('answers 404 CASH_SESSION_NOT_FOUND for a session this lot does not have', async () => {
        // The tenant-scoped client returns null for another lot's session too,
        // so both cases get the same answer.
        mockTenant.cashSession.findFirst.mockResolvedValue(null);

        const failure = await service
          .getRevenue({ cashSessionId: SESSION_ID })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(FormattedException);
        expect(problem(failure).status).toBe(404);
        expect(problem(failure).code).toBe('CASH_SESSION_NOT_FOUND');
      });

      it('checks the session exists even when the window is explicit', async () => {
        // Otherwise a mistyped id would chart a shift of zeros.
        mockTenant.cashSession.findFirst.mockResolvedValue(null);

        const failure = await service
          .getPaymentMethodBreakdown({
            from: '2026-09-07T06:00:00-03:00',
            to: '2026-09-07T14:00:00-03:00',
            cashSessionId: SESSION_ID,
          })
          .catch((error: unknown) => error);

        expect(problem(failure).code).toBe('CASH_SESSION_NOT_FOUND');
      });

      it('looks the session up through the tenant-scoped client', async () => {
        await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        expect(mockTenant.cashSession.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: SESSION_ID } }),
        );
      });

      it('derives the window from a closed shift', async () => {
        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        expect(result.from).toEqual(OPENED);
        expect(result.to).toEqual(CLOSED);
        expect(result.buckets).toHaveLength(8);
      });

      it('runs a shift that is still open until now', async () => {
        mockTenant.cashSession.findFirst.mockResolvedValue({
          id: SESSION_ID,
          openedAt: new Date(Date.now() - 2 * 3_600_000),
          closedAt: null,
        });
        const before = Date.now();

        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        expect(result.to.getTime()).toBeGreaterThanOrEqual(before);
      });

      it('widens the window to a payment synced after its shift closed', async () => {
        // Collected by this session, but stamped ten minutes after it closed —
        // the offline case that approximating by clock window gets wrong.
        const late = new Date(CLOSED.getTime() + 10 * 60_000);
        paidBetween(new Date(OPENED.getTime() + 3_600_000), late);
        mockTenant.paymentTransaction.findMany.mockResolvedValue([
          {
            amount: new Prisma.Decimal(5000),
            entryId: 'late-entry',
            entry: { leftAt: late },
          },
        ]);

        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        // `to` is exclusive, hence the extra millisecond.
        expect(result.to.getTime()).toBe(late.getTime() + 1);
        expect(result.totals.revenue).toBe(5000);
        expect(result.totals.vehiclesOut).toBe(1);
      });

      it('widens backwards for a payment stamped before the shift opened', async () => {
        const early = new Date(OPENED.getTime() - 15 * 60_000);
        paidBetween(early, null);

        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        expect(result.from).toEqual(early);
        expect(result.to).toEqual(CLOSED);
      });

      it('uses explicit bounds verbatim, without widening', async () => {
        paidBetween(
          new Date('2026-09-01T00:00:00.000Z'),
          new Date('2026-09-30T00:00:00.000Z'),
        );

        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          from: '2026-09-07T10:00:00Z',
          to: '2026-09-07T12:00:00Z',
          granularity: 'hour',
        });

        expect(result.from).toEqual(new Date('2026-09-07T10:00:00.000Z'));
        expect(result.to).toEqual(new Date('2026-09-07T12:00:00.000Z'));
        // Both bounds came, so the span is never even queried.
        expect(mockTenant.entry.aggregate).not.toHaveBeenCalled();
      });

      it('derives only the bound that is missing', async () => {
        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          from: '2026-09-07T10:00:00Z',
          granularity: 'hour',
        });

        expect(result.from).toEqual(new Date('2026-09-07T10:00:00.000Z'));
        expect(result.to).toEqual(CLOSED);
      });

      it('rejects an explicit window that ends before it starts', async () => {
        const failure = await service
          .getRevenue({
            cashSessionId: SESSION_ID,
            from: '2026-09-07T12:00:00Z',
            to: '2026-09-07T10:00:00Z',
          })
          .catch((error: unknown) => error);

        expect(problem(failure).status).toBe(400);
      });
    });

    describe('source', () => {
      it('sums what the session collected, from the transactions', async () => {
        const result = await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        expect(result.revenueSource).toBe('paymentTransactions');
        const [where] = loose(mockTenant.paymentTransaction.findMany);
        // Top-level on the transaction, so the tenant scope covers it.
        expect(where.cashSessionId).toBe(SESSION_ID);
        expect(where).not.toHaveProperty('paymentMethodName');
        expect(where.entry).toMatchObject({ tenantId: 'tenant-1' });
        // A corrected payment leaves a tombstone; summing it would count the
        // corrected stay twice.
        expect(where.deletedAt).toBeNull();
      });

      it('attributes reservation prepayment to the exit session: its payments, else the shift window', async () => {
        await service.getRevenue({
          cashSessionId: SESSION_ID,
          granularity: 'hour',
        });

        const prepaidWhere = loose(mockTenant.entry.findMany)
          .map((args) => args as { prepaidAmountArs?: unknown })
          .find((where) => where.prepaidAmountArs) as {
          OR: Record<string, unknown>[];
          cashSessionId?: unknown;
        };
        // Never the entry drawer.
        expect(prepaidWhere).not.toHaveProperty('cashSessionId');
        expect(prepaidWhere.OR[0].paymentTransactions).toEqual(
          COLLECTED_BY_SESSION,
        );
        // $0 exits have no payment: no live payment under any session, and
        // `leftAt` inside the shift, end exclusive.
        expect(prepaidWhere.OR[1]).toEqual({
          paymentTransactions: {
            none: {
              tenantId: 'tenant-1',
              cashSessionId: { not: null },
              deletedAt: null,
            },
          },
          leftAt: { gte: OPENED, lt: CLOSED },
        });
      });

      it('never matches the drawer a car entered under', async () => {
        await service.getTopPlates({ cashSessionId: SESSION_ID });

        const [where] = loose(mockTenant.entry.findMany);
        // `entries.cashSessionId` follows a car into every later shift while
        // it stays parked; only the transaction knows who took the money.
        expect(where).not.toHaveProperty('cashSessionId');
        const branches = where.OR as Record<string, unknown>[];
        expect(branches[0].paymentTransactions).toEqual(COLLECTED_BY_SESSION);
      });

      it('keeps a $0 exit covered by a prepayment in the category and top-plates stays', async () => {
        const shiftWindowBranch = {
          paymentTransactions: {
            none: {
              tenantId: 'tenant-1',
              cashSessionId: { not: null },
              deletedAt: null,
            },
          },
          leftAt: { gte: OPENED, lt: CLOSED },
        };

        await service.getVehicleCategoryBreakdown({
          cashSessionId: SESSION_ID,
        });
        await service.getTopPlates({ cashSessionId: SESSION_ID });

        const groupWheres = loose(mockTenant.entry.groupBy);
        const plateWheres = loose(mockTenant.entry.findMany).filter(
          (where) => !where.prepaidAmountArs,
        );
        for (const where of [...groupWheres, ...plateWheres]) {
          const branches = where.OR as Record<string, unknown>[];
          expect(branches[0].paymentTransactions).toEqual(COLLECTED_BY_SESSION);
          expect(branches[1]).toEqual(shiftWindowBranch);
        }
        expect(groupWheres.length).toBeGreaterThan(0);
        expect(plateWheres.length).toBeGreaterThan(0);
      });

      it('matches method and session on the same transaction', async () => {
        await service.getRevenue({
          cashSessionId: SESSION_ID,
          paymentMethod: 'cash',
          granularity: 'hour',
        });

        const [exits] = loose(mockTenant.paymentTransaction.findMany);
        expect(exits).toMatchObject({
          paymentMethodName: 'cash',
          cashSessionId: SESSION_ID,
        });
        // Arrivals: stays with one transaction that is both cash AND this
        // session — not one of each.
        const [arrivals] = loose(mockTenant.entry.findMany);
        expect(arrivals.paymentTransactions).toEqual({
          some: {
            paymentMethodName: 'cash',
            cashSessionId: SESSION_ID,
            tenantId: 'tenant-1',
            deletedAt: null,
          },
        });
      });

      it('scopes both halves of the pie to the session', async () => {
        await service.getPaymentMethodBreakdown({ cashSessionId: SESSION_ID });

        const [slices] = loose(mockTenant.paymentTransaction.groupBy);
        expect(slices.cashSessionId).toBe(SESSION_ID);

        // The authoritative total is the aggregate with `_sum`; the other one
        // is the span query.
        const totals = mockTenant.entry.aggregate.mock.calls
          .map((call) => call[0] as { _sum?: unknown; where: AnyWhere })
          .find((args) => args._sum !== undefined);
        expect(totals?.where.paymentTransactions).toEqual(COLLECTED_BY_SESSION);
      });
    });
  });
  describe('reservation revenue (accrual)', () => {
    const range = {
      from: '2026-08-07T00:00:00-03:00',
      to: '2026-08-08T00:00:00-03:00',
      tz: 'America/Argentina/Buenos_Aires',
    };
    const leftAt = new Date('2026-08-07T15:00:00Z');

    /** Car entered 10 minutes, prepaid $3000 via MP, the till charged $0. */
    const prepaidStay = () => {
      mockTenant.entry.findMany
        .mockResolvedValueOnce([
          { id: 'e1', leftAt, amountPaid: new Prisma.Decimal(0) },
        ]) // exits
        .mockResolvedValueOnce([]) // arrivals
        .mockResolvedValueOnce([
          { leftAt, prepaidAmountArs: new Prisma.Decimal(3000) },
        ]); // reservation prepaid
    };

    it('counts the prepayment of a stay charged $0 as revenue on its exit day', async () => {
      prepaidStay();

      const result = await service.getRevenue({ ...range, granularity: 'day' });

      expect(result.totals.revenue).toBe(3000);
      expect(result.totals.reservationRevenue).toBe(3000);
      expect(result.totals.vehiclesOut).toBe(1);
    });

    it('recognises a no-show and a partially kept cancellation, net of refunds', async () => {
      mockTenant.reservation.findMany.mockResolvedValue([
        {
          status: 'no_show',
          entryAt: new Date('2026-08-07T12:00:00Z'),
          cancelledAt: null,
          totalArs: new Prisma.Decimal(5000),
          paidAt: new Date('2026-08-06T12:00:00Z'),
          refundStatus: 'none',
          refundedAmountArs: null,
          refundRequestedArs: null,
          payments: [{ amountArs: new Prisma.Decimal(5000) }],
        },
        {
          status: 'cancelled',
          entryAt: new Date('2026-08-09T12:00:00Z'),
          cancelledAt: new Date('2026-08-07T13:00:00Z'),
          totalArs: new Prisma.Decimal(4000),
          paidAt: new Date('2026-08-06T12:00:00Z'),
          refundStatus: 'refunded',
          refundedAmountArs: new Prisma.Decimal(3000),
          refundRequestedArs: new Prisma.Decimal(3000),
          payments: [{ amountArs: new Prisma.Decimal(4000) }],
        },
        {
          // Fully refunded: nothing is kept.
          status: 'cancelled',
          entryAt: new Date('2026-08-09T12:00:00Z'),
          cancelledAt: new Date('2026-08-07T13:00:00Z'),
          totalArs: new Prisma.Decimal(4000),
          paidAt: new Date('2026-08-06T12:00:00Z'),
          refundStatus: 'refunded',
          refundedAmountArs: new Prisma.Decimal(4000),
          refundRequestedArs: new Prisma.Decimal(4000),
          payments: [{ amountArs: new Prisma.Decimal(4000) }],
        },
      ]);

      const result = await service.getRevenue({ ...range, granularity: 'day' });

      expect(result.totals.reservationRevenue).toBe(6000);
      expect(result.totals.revenue).toBe(6000);
    });

    it('puts the prepayment in its own bucket, not in unallocated', async () => {
      mockTenant.entry.aggregate.mockResolvedValue({
        _sum: { amountPaid: new Prisma.Decimal(1000) },
      });
      mockTenant.paymentTransaction.groupBy.mockResolvedValue([
        {
          paymentMethodName: 'Efectivo',
          _sum: { amount: new Prisma.Decimal(1000) },
          _count: { _all: 1 },
        },
      ]);
      mockTenant.entry.findMany.mockResolvedValue([
        { leftAt, prepaidAmountArs: new Prisma.Decimal(3000) },
      ]);

      const result = await service.getPaymentMethodBreakdown(range);

      expect(result.total).toBe(4000);
      expect(result.unallocated).toBe(0);
      expect(result.methods[0]).toEqual({
        name: 'Mercado Pago (reserva)',
        kind: 'reservation',
        amount: 3000,
        count: 1,
        share: 0.75,
      });
    });

    it('includes reservation money only when filtering by its bucket', async () => {
      mockTenant.entry.findMany.mockImplementation(
        ({ where }: { where: { prepaidAmountArs?: unknown } }) =>
          Promise.resolve(
            where.prepaidAmountArs
              ? [{ leftAt, prepaidAmountArs: new Prisma.Decimal(3000) }]
              : [],
          ),
      );

      const cash = await service.getRevenue({
        ...range,
        paymentMethod: 'Efectivo',
      });
      expect(cash.totals.reservationRevenue).toBe(0);

      mockTenant.paymentTransaction.findMany.mockResolvedValue([]);
      const reservation = await service.getRevenue({
        ...range,
        paymentMethod: 'Mercado Pago (reserva)',
      });
      expect(reservation.totals.reservationRevenue).toBe(3000);
    });

    it('adds the prepayment to the stay in plates and categories', async () => {
      mockTenant.entry.findMany.mockResolvedValue([
        {
          plate: 'AB123CD',
          enteredAt: new Date('2026-08-07T14:50:00Z'),
          leftAt,
          amountPaid: new Prisma.Decimal(0),
          prepaidAmountArs: new Prisma.Decimal(3000),
        },
      ]);
      const plates = await service.getTopPlates(range);
      expect(plates.items[0].revenue).toBe(3000);

      mockTenant.entry.groupBy.mockResolvedValue([
        {
          vehicleCategory: 'auto',
          _count: { _all: 1 },
          _sum: {
            amountPaid: new Prisma.Decimal(0),
            prepaidAmountArs: new Prisma.Decimal(3000),
          },
        },
      ]);
      const categories = await service.getVehicleCategoryBreakdown(range);
      expect(categories.totalRevenue).toBe(3000);
    });

    it('summary day totals include the prepayment', async () => {
      mockTenant.entry.aggregate.mockResolvedValue({
        _sum: {
          amountPaid: new Prisma.Decimal(0),
          prepaidAmountArs: new Prisma.Decimal(3000),
        },
        _count: 1,
      });

      const result = await service.getSummary({});

      expect(result.today.revenue).toBe(3000);
      expect(result.today.reservationRevenue).toBe(3000);
    });
  });
});
