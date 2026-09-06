import { HttpStatus, Injectable } from '@nestjs/common';
import { LprDetectionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { readCapacity } from '../entities/entity-settings';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MetricsTzQueryDto } from './dto/metrics-tz-query.dto';
import { MetricsWindowQueryDto } from './dto/metrics-window-query.dto';
import {
  OccupancyDto,
  OccupancyResponseDto,
} from './dto/occupancy-response.dto';
import { PaymentMethodBreakdownDto } from './dto/payment-method-breakdown.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import {
  TopPlatesQueryDto,
  type TopPlatesOrder,
} from './dto/top-plates-query.dto';
import { TopPlatesResponseDto } from './dto/top-plates-response.dto';
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
const BREAKDOWN_INSTANCE =
  '/tenants/:tenantId/metrics/revenue/by-payment-method';
const TOP_PLATES_INSTANCE = '/tenants/:tenantId/metrics/top-plates';

/** How many plates the ranking returns when the caller does not say. */
const DEFAULT_TOP_PLATES = 10;

const MS_PER_MINUTE = 60_000;

/** Whole minutes a stay lasted. Defensive against a null or inverted exit. */
function minutesBetween(enteredAt: Date, leftAt: Date | null): number {
  if (!leftAt) return 0;
  const elapsed = leftAt.getTime() - enteredAt.getTime();
  return elapsed > 0 ? Math.round(elapsed / MS_PER_MINUTE) : 0;
}

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

/**
 * The optional vehicle-type filter, as a `where` fragment.
 *
 * `entries.vehicleType` is a **text snapshot** of the type name taken at
 * ingress, not a foreign key into `vehicle_types` (see
 * `20260901012009_entries_vehicle_type_snapshot.sql`): a stay from eight months
 * ago must not change meaning because the owner renamed or deleted the type.
 * So the match is a plain string equality against that snapshot, and the filter
 * is deliberately *not* validated against the tenant's live catalogue — doing
 * so would reject a perfectly legitimate query for a type that has since been
 * renamed away.
 */
function vehicleTypeWhere(vehicleType?: string): {
  vehicleType?: string;
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
    const { from, to } = this.resolveWindow(query, REVENUE_INSTANCE);

    if (exceedsBucketLimit(from, to, granularity)) {
      throw this.badWindow(
        REVENUE_INSTANCE,
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
   * Revenue split by payment method, for the dashboard's pie chart.
   *
   * Reconciles two tables that legitimately disagree. `entries.amountPaid` is
   * the authoritative total, but the per-method split only exists in
   * `payment_transactions` — and a stay closed through the offline
   * `amountPaid` fallback never wrote one. The gap is reported as
   * `unallocated` rather than quietly dropped, so the slices always add up to
   * the KPI the owner sees elsewhere.
   */
  async getPaymentMethodBreakdown(
    query: MetricsWindowQueryDto,
  ): Promise<PaymentMethodBreakdownDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const { from, to } = this.resolveWindow(query, BREAKDOWN_INSTANCE);
    const leftAt = { gte: from, lt: to };

    const [authoritative, groups] = await Promise.all([
      tenantPrisma.entry.aggregate({
        _sum: { amountPaid: true },
        where: { leftAt, ...vehicleTypeWhere(query.vehicleType) },
      }),
      tenantPrisma.paymentTransaction.groupBy({
        by: ['paymentMethodName'],
        _sum: { amount: true },
        _count: { _all: true },
        where: {
          entry: {
            // See `loadExits`: the tenant scope does not reach into a nested
            // relation filter, and without it the range cannot use the index.
            tenantId: this.tenantContext.getTenantIdOrThrow(),
            leftAt,
            ...vehicleTypeWhere(query.vehicleType),
          },
        },
      }),
    ]);

    const total = roundMoney(Number(authoritative._sum.amountPaid ?? 0));
    const methods = groups
      .map((group) => ({
        name: group.paymentMethodName,
        amount: roundMoney(Number(group._sum.amount ?? 0)),
        count: group._count._all,
        share: null as number | null,
      }))
      .sort((a, b) => b.amount - a.amount);

    const allocated = roundMoney(
      methods.reduce((sum, method) => sum + method.amount, 0),
    );
    for (const method of methods) {
      method.share = total > 0 ? roundRatio(method.amount / total) : null;
    }

    return {
      from,
      to,
      currency: CURRENCY,
      total,
      allocated,
      unallocated: roundMoney(total - allocated),
      methods,
    };
  }

  /**
   * The plates that mattered most over the window.
   *
   * Only stays that **ended** in the window count: an open stay has no final
   * amount and no known duration, so including it would understate both.
   *
   * Rows are aggregated in memory rather than by `groupBy` because duration
   * has no SQL expression in Prisma's grouping API, and computing two of the
   * three metrics one way and the third another would risk them disagreeing.
   */
  async getTopPlates(query: TopPlatesQueryDto): Promise<TopPlatesResponseDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const { from, to } = this.resolveWindow(query, TOP_PLATES_INSTANCE);
    const orderBy: TopPlatesOrder = query.orderBy ?? 'revenue';
    const limit = query.limit ?? DEFAULT_TOP_PLATES;

    const stays = await tenantPrisma.entry.findMany({
      where: {
        leftAt: { gte: from, lt: to },
        ...vehicleTypeWhere(query.vehicleType),
      },
      select: { plate: true, enteredAt: true, leftAt: true, amountPaid: true },
    });

    const byPlate = new Map<
      string,
      { revenue: number; visits: number; totalMinutes: number }
    >();
    for (const stay of stays) {
      const bucket = byPlate.get(stay.plate) ?? {
        revenue: 0,
        visits: 0,
        totalMinutes: 0,
      };
      bucket.revenue += Number(stay.amountPaid ?? 0);
      bucket.visits += 1;
      bucket.totalMinutes += minutesBetween(stay.enteredAt, stay.leftAt);
      byPlate.set(stay.plate, bucket);
    }

    const ranked = [...byPlate.entries()]
      .map(([plate, totals]) => ({
        plate,
        revenue: roundMoney(totals.revenue),
        visits: totals.visits,
        totalMinutes: totals.totalMinutes,
        averageMinutes: Math.round(totals.totalMinutes / totals.visits),
      }))
      .sort((a, b) => {
        if (orderBy === 'visits') return b.visits - a.visits;
        if (orderBy === 'duration') return b.totalMinutes - a.totalMinutes;
        return b.revenue - a.revenue;
      })
      .slice(0, limit);

    return { from, to, currency: CURRENCY, orderBy, items: ranked };
  }

  /**
   * Parses and validates the `from`/`to` pair shared by every analytical
   * endpoint. The offset is already enforced by `@IsOffsetDateTime`, so all
   * that is left is ordering.
   */
  private resolveWindow(
    query: MetricsWindowQueryDto,
    instance: string,
  ): { from: Date; to: Date } {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw this.badWindow(instance, '`from` must be earlier than `to`.');
    }
    return { from, to };
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

  private badWindow(instance: string, detail: string): FormattedException {
    return new FormattedException(
      'Bad Request',
      HttpStatus.BAD_REQUEST,
      detail,
      instance,
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
   * Capacity has a single source: `tenant.settings.capacity.total`. It used to
   * prefer the sum of enabled `services.spots` and fall back to the profile,
   * reporting which one it used in a `capacitySource` field, because the two
   * were seeded together at onboarding and drifted afterwards — neither write
   * path synced the other. `capacity_total_and_service_code_v2` collapsed them:
   * spots are one general capacity on the profile, and "which vehicles the lot
   * accepts" moved to `vehicle_types.accepted`. With one source there is
   * nothing left to disambiguate, so `capacitySource` is gone.
   */
  private async computeOccupancy(): Promise<OccupancyDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const [tenant, occupied] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      }),
      tenantPrisma.entry.count({ where: { leftAt: null } }),
    ]);

    const capacity = readCapacity(tenant?.settings ?? {}).total;

    return {
      capacity,
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
