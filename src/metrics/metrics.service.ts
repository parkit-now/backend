import { HttpStatus, Injectable } from '@nestjs/common';
import { LprDetectionStatus, VehicleType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { readCapacity } from '../entities/entity-settings';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MetricsTzQueryDto } from './dto/metrics-tz-query.dto';
import {
  CapacitySource,
  OccupancyDto,
  OccupancyResponseDto,
} from './dto/occupancy-response.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import {
  RevenueBucketDto,
  RevenueResponseDto,
  RevenueSource,
} from './dto/revenue-response.dto';
import {
  DayComparisonDto,
  DayTotalsDto,
  MetricsSummaryDto,
} from './dto/summary-response.dto';
import {
  Bucket,
  DEFAULT_TIME_ZONE,
  DayKey,
  Granularity,
  bucketRange,
  dayKeyIn,
  exceedsBucketLimit,
  MAX_BUCKETS,
  partialDayRangeIn,
  shiftDayKey,
} from './metrics-tz';

/** Bucket label for open entries that never declared a vehicle type. */
const UNKNOWN_VEHICLE_TYPE = 'unknown';

/** Every monetary figure in this module is in Argentine pesos. */
const CURRENCY = 'ARS';

const REVENUE_INSTANCE = '/tenants/:tenantId/metrics/revenue';

/** Ratios are money-adjacent; 4 decimals is plenty and keeps JSON readable. */
function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Relative change against a baseline. `null` on a zero baseline: the honest
 * answer is "no comparable data", not `Infinity`.
 */
function deltaPct(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return roundRatio((current - baseline) / baseline);
}

/**
 * Summing `Decimal`s converted to `number` accumulates binary drift, which
 * surfaces as totals like `12299.999999999998`. Snap back to cents.
 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function vehicleTypeWhere(vehicleType?: VehicleType): {
  vehicleType?: VehicleType;
} {
  return vehicleType ? { vehicleType } : {};
}

/**
 * Index of the bucket containing `instant`, or `-1`.
 *
 * Binary search rather than a linear scan: buckets are sorted, contiguous and
 * half-open, and this runs once per row of the window.
 */
function indexOfBucket(buckets: Bucket[], instant: Date): number {
  const target = instant.getTime();
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (target < buckets[mid].gte.getTime()) high = mid - 1;
    else if (target >= buckets[mid].lt.getTime()) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Read-only aggregations powering the owner dashboard.
 *
 * Every query goes through `getTenantClient()`, which injects `WHERE tenantId`
 * on reads — `tenantId` is never threaded through as an argument. The one
 * exception is `Tenant` itself: it is a global table (not in `TENANT_MODELS`),
 * so the capacity fallback reads it by id, which the `TenantMembershipGuard`
 * has already authorized for this request.
 */
@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Every headline KPI for the dashboard, in one round trip. */
  async getSummary(query: MetricsTzQueryDto): Promise<MetricsSummaryDto> {
    const tz = query.tz ?? DEFAULT_TIME_ZONE;
    const tenantPrisma = this.prisma.getTenantClient();

    const generatedAt = new Date();
    const day = dayKeyIn(generatedAt, tz);
    const { gte: dayStart } = partialDayRangeIn(day, tz, 0);
    // How far into the civil day we are; baselines get truncated to match.
    const elapsedMs = generatedAt.getTime() - dayStart.getTime();

    const previousDayKey = shiftDayKey(day, -1);
    const previousWeekKey = shiftDayKey(day, -7);

    const [occupancy, today, previousDay, previousWeek, pendingLprEvents] =
      await Promise.all([
        this.computeOccupancy(),
        this.dayTotals(day, tz, elapsedMs),
        this.dayTotals(previousDayKey, tz, elapsedMs),
        this.dayTotals(previousWeekKey, tz, elapsedMs),
        tenantPrisma.lprDetectionEvent.count({
          where: { status: LprDetectionStatus.pending, archivedAt: null },
        }),
      ]);

    return {
      tz,
      day,
      generatedAt,
      occupancy,
      today,
      comparison: {
        previousDay: this.withDeltas(today, previousDay),
        previousWeek: this.withDeltas(today, previousWeek),
      },
      alerts: { pendingLprEvents },
    };
  }

  /**
   * Revenue and vehicle counts over an arbitrary window, bucketed by calendar.
   *
   * Rows are fetched once and bucketed in memory rather than issuing one query
   * per bucket: a month at hourly granularity would otherwise mean ~720 round
   * trips. `MAX_BUCKETS` keeps both the payload and that in-memory pass bounded.
   */
  async getRevenue(query: RevenueQueryDto): Promise<RevenueResponseDto> {
    const tz = query.tz ?? DEFAULT_TIME_ZONE;
    const granularity: Granularity = query.granularity ?? 'day';
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (from >= to) {
      throw this.badRevenueRange('`from` must be earlier than `to`.');
    }
    if (exceedsBucketLimit(from, to, granularity)) {
      throw this.badRevenueRange(
        `This range at '${granularity}' granularity exceeds the ${MAX_BUCKETS}-bucket limit. Widen the granularity or shorten the range.`,
      );
    }

    const buckets = bucketRange(from, to, granularity, tz);
    const revenueSource: RevenueSource = query.paymentMethod
      ? 'paymentTransactions'
      : 'entries';

    const [exits, arrivals] = await Promise.all([
      this.loadExits(from, to, query),
      this.loadArrivals(from, to, query),
    ]);

    const rows: RevenueBucketDto[] = buckets.map((bucket) => ({
      key: bucket.key,
      from: bucket.gte,
      to: bucket.lt,
      revenue: 0,
      vehiclesIn: 0,
      vehiclesOut: 0,
    }));

    // A stay filtered by payment method can contribute several transactions to
    // the same bucket, so revenue accumulates per row while `vehiclesOut`
    // counts distinct stays. (A stay has one `leftAt`, hence exactly one
    // bucket, so summing the per-bucket counts still yields a global distinct.)
    const countedExits = rows.map(() => new Set<string>());
    for (const exit of exits) {
      const index = indexOfBucket(buckets, exit.at);
      if (index === -1) continue;
      rows[index].revenue += exit.amount;
      if (!countedExits[index].has(exit.entryId)) {
        countedExits[index].add(exit.entryId);
        rows[index].vehiclesOut += 1;
      }
    }
    for (const arrival of arrivals) {
      const index = indexOfBucket(buckets, arrival);
      if (index !== -1) rows[index].vehiclesIn += 1;
    }

    return {
      from,
      to,
      tz,
      granularity,
      revenueSource,
      currency: CURRENCY,
      totals: {
        key: `${granularity}:${from.toISOString()}/${to.toISOString()}`,
        from,
        to,
        revenue: roundMoney(rows.reduce((sum, r) => sum + r.revenue, 0)),
        vehiclesIn: arrivals.length,
        vehiclesOut: rows.reduce((sum, r) => sum + r.vehiclesOut, 0),
      },
      buckets: rows.map((row) => ({
        ...row,
        revenue: roundMoney(row.revenue),
      })),
    };
  }

  /**
   * Stays that ended in the window, as `{ at: leftAt, amount }` pairs.
   *
   * Without a payment-method filter the amount is the stay's own `amountPaid`.
   * With one, it comes from the matching `payment_transactions` instead —
   * a stay can split a single exit across cash and transfer, so charging the
   * whole `amountPaid` to one method would overstate it. Each transaction is
   * counted as its own exit row, then de-duplicated per bucket by entry id.
   */
  private async loadExits(
    from: Date,
    to: Date,
    query: RevenueQueryDto,
  ): Promise<{ at: Date; amount: number; entryId: string }[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const leftAt = { gte: from, lt: to };

    if (!query.paymentMethod) {
      const entries = await tenantPrisma.entry.findMany({
        where: { leftAt, ...vehicleTypeWhere(query.vehicleType) },
        select: { id: true, leftAt: true, amountPaid: true },
      });
      return entries.map((entry) => ({
        at: entry.leftAt as Date,
        amount: Number(entry.amountPaid ?? 0),
        entryId: entry.id,
      }));
    }

    const transactions = await tenantPrisma.paymentTransaction.findMany({
      where: {
        paymentMethodName: query.paymentMethod,
        entry: {
          // `prismaForTenant` injects `tenantId` at the top level only, so a
          // nested relation filter reaches `entries` without one. Correctness
          // is unaffected (a transaction's entry is always same-tenant, by FK
          // and RLS), but the planner then cannot use the composite
          // `(tenant_id, left_at)` index and falls back to a full scan of
          // `entries`. Restating the tenant here keeps the index in play.
          tenantId: this.tenantContext.getTenantIdOrThrow(),
          leftAt,
          ...vehicleTypeWhere(query.vehicleType),
        },
      },
      select: {
        amount: true,
        entryId: true,
        entry: { select: { leftAt: true } },
      },
    });
    return transactions.map((tx) => ({
      at: tx.entry.leftAt as Date,
      amount: Number(tx.amount),
      entryId: tx.entryId,
    }));
  }

  /** Instants at which stays arrived in the window. */
  private async loadArrivals(
    from: Date,
    to: Date,
    query: RevenueQueryDto,
  ): Promise<Date[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const entries = await tenantPrisma.entry.findMany({
      where: {
        enteredAt: { gte: from, lt: to },
        ...vehicleTypeWhere(query.vehicleType),
        // With a method filter, "vehicles in" means the stays that ended up
        // paying with it — otherwise the two series would answer different
        // questions on the same chart.
        ...(query.paymentMethod
          ? {
              paymentTransactions: {
                some: { paymentMethodName: query.paymentMethod },
              },
            }
          : {}),
      },
      select: { enteredAt: true },
    });
    return entries.map((entry) => entry.enteredAt);
  }

  private badRevenueRange(detail: string): FormattedException {
    return new FormattedException(
      'Bad Request',
      HttpStatus.BAD_REQUEST,
      detail,
      REVENUE_INSTANCE,
      ErrorCodes.VALIDATION_FAILED,
    );
  }

  /** Live occupancy plus the best-effort per-vehicle-type breakdown. */
  async getOccupancy(): Promise<OccupancyResponseDto> {
    const tenantPrisma = this.prisma.getTenantClient();

    const [occupancy, groups] = await Promise.all([
      this.computeOccupancy(),
      tenantPrisma.entry.groupBy({
        by: ['vehicleType'],
        _count: { _all: true },
        where: { leftAt: null },
      }),
    ]);

    const byVehicleType = groups
      .map((group) => ({
        type: group.vehicleType ?? UNKNOWN_VEHICLE_TYPE,
        occupied: group._count._all,
      }))
      .sort((a, b) => b.occupied - a.occupied);

    return { ...occupancy, byVehicleType };
  }

  /**
   * Occupancy denominator + numerator.
   *
   * Capacity prefers the sum of enabled `services.spots` and falls back to the
   * profile's `settings.capacity`, reporting which one it used. The two are
   * seeded together at onboarding but drift afterwards, since the profile and
   * services write paths do not sync each other.
   */
  private async computeOccupancy(): Promise<OccupancyDto> {
    const tenantPrisma = this.prisma.getTenantClient();

    const [services, occupied] = await Promise.all([
      tenantPrisma.service.findMany({
        where: { enabled: true },
        select: { spots: true },
      }),
      tenantPrisma.entry.count({ where: { leftAt: null } }),
    ]);

    let capacity = services.reduce((total, row) => total + row.spots, 0);
    let capacitySource: CapacitySource = capacity > 0 ? 'services' : 'none';

    if (capacity === 0) {
      const tenantId = this.tenantContext.getTenantIdOrThrow();
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const declared = readCapacity(tenant?.settings ?? {});
      capacity =
        declared.carSpots + declared.motorcycleSpots + declared.bicycleSpots;
      if (capacity > 0) capacitySource = 'settings';
    }

    return {
      capacity,
      capacitySource,
      occupied,
      // Floored at 0: a lot can hold more vehicles than its configured spots.
      free: capacity > 0 ? Math.max(capacity - occupied, 0) : null,
      occupancyPct: capacity > 0 ? roundRatio(occupied / capacity) : null,
    };
  }

  /**
   * Revenue and vehicle counts over the first `elapsedMs` of a civil day.
   *
   * Revenue is summed from `entries.amountPaid` at exit time: payments live in
   * `payment_transactions`, which has no timestamp of its own (only the
   * sync-managed `updated_at`), so `leftAt` is the only sound time axis.
   */
  private async dayTotals(
    dayKey: DayKey,
    tz: string,
    elapsedMs: number,
  ): Promise<DayTotalsDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const { gte, lt } = partialDayRangeIn(dayKey, tz, elapsedMs);

    const [closed, vehiclesIn] = await Promise.all([
      tenantPrisma.entry.aggregate({
        _sum: { amountPaid: true },
        _count: true,
        where: { leftAt: { gte, lt } },
      }),
      tenantPrisma.entry.count({ where: { enteredAt: { gte, lt } } }),
    ]);

    return {
      day: dayKey,
      revenue: Number(closed._sum.amountPaid ?? 0),
      vehiclesIn,
      vehiclesOut: closed._count,
    };
  }

  private withDeltas(
    today: DayTotalsDto,
    baseline: DayTotalsDto,
  ): DayComparisonDto {
    return {
      ...baseline,
      revenueDeltaPct: deltaPct(today.revenue, baseline.revenue),
      vehiclesInDeltaPct: deltaPct(today.vehiclesIn, baseline.vehiclesIn),
    };
  }
}
