import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LprDetectionStatus,
  Prisma,
  ReservationPaymentStatus,
  ReservationStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { readCapacity } from '../entities/entity-settings';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { calcStayPrice } from '../entries/pricing';
import { prepaidAmountOf } from '../reservations/reservation-checkin';
import { countReservedHeld } from '../driver/driver-rules';
import {
  RESERVED_HELD_SELECT,
  reservedTodayWhere,
} from '../reservations/reservation-capacity';
import { MetricsTzQueryDto } from './dto/metrics-tz-query.dto';
import { MetricsWindowQueryDto } from './dto/metrics-window-query.dto';
import {
  OccupancyDto,
  OccupancyResponseDto,
} from './dto/occupancy-response.dto';
import {
  PaymentMethodBreakdownDto,
  PaymentMethodSliceDto,
  RESERVATION_PAYMENT_METHOD,
} from './dto/payment-method-breakdown.dto';
import { RevenueQueryDto } from './dto/revenue-query.dto';
import {
  TopPlatesQueryDto,
  type TopPlatesOrder,
} from './dto/top-plates-query.dto';
import { TopPlatesResponseDto } from './dto/top-plates-response.dto';
import {
  VehicleCategoryBreakdownDto,
  VehicleCategorySliceDto,
} from './dto/vehicle-category-breakdown.dto';
import {
  isVehicleCategory,
  type VehicleCategory,
} from '../vehicle-categories/vehicle-categories';
import {
  RevenueBucketDto,
  RevenueResponseDto,
  RevenueSource,
} from './dto/revenue-response.dto';
import {
  DayComparisonDto,
  DayTotalsDto,
  MetricsSummaryDto,
  ProjectionConfidence,
  RevenueProjectionDto,
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

/** A category that is not in the closed list reads as "Sin dato" (null). */
function toVehicleCategory(value: string | null): VehicleCategory | null {
  return isVehicleCategory(value) ? value : null;
}

/**
 * Orders rows by their count, most first, with the `null` ("Sin dato") group
 * always last: it is the absence of an answer, not a category to rank.
 */
function byCountWithUnknownLast<T extends Record<K, number>, K extends string>(
  category: (row: T) => string | null,
  count: K,
): (a: T, b: T) => number {
  return (a, b) => {
    const aUnknown = category(a) === null;
    const bUnknown = category(b) === null;
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return b[count] - a[count];
  };
}

/** Every monetary figure in this module is in Argentine pesos. */
const CURRENCY = 'ARS';

const REVENUE_INSTANCE = '/tenants/:tenantId/metrics/revenue';
/** `category` of the by-vehicle-category slice for reservation money with no stay. */
const RESERVATION_UNUSED_CATEGORY = 'reservation_unused' as const;
const BREAKDOWN_INSTANCE =
  '/tenants/:tenantId/metrics/revenue/by-payment-method';
const TOP_PLATES_INSTANCE = '/tenants/:tenantId/metrics/top-plates';
const VEHICLE_CATEGORY_INSTANCE =
  '/tenants/:tenantId/metrics/by-vehicle-category';

/** How many plates the ranking returns when the caller does not say. */
const DEFAULT_TOP_PLATES = 10;

const MS_PER_MINUTE = 60_000;
const HISTORICAL_WEEKDAY_SAMPLES = 8;
const MONTH_REMAINING_WEEKDAY_SAMPLES = 4;

/** The part of a cash session that defines its window. */
type SessionBounds = { id: string; openedAt: Date; closedAt: Date | null };

/**
 * One piece of reservation money recognised in the window (accrual basis).
 *
 * - `prepaid`: the Mercado Pago prepayment of a stay that came, dated at the
 *   stay's `leftAt` (same instant as its `amountPaid`; at the till only
 *   `max(stay - prepaid, 0)` is charged, so the two never overlap).
 * - `no_show`: what the driver paid for a reservation that never became a
 *   stay (net of refunds), dated at the reservation's `entryAt`.
 * - `retained`: what the lot kept after a cancellation with a partial refund,
 *   dated at `cancelledAt`.
 */
type ReservationRevenueRow = {
  at: Date;
  amount: number;
  kind: 'prepaid' | 'no_show' | 'retained';
};

/** The filters of the revenue queries that also reach reservation money. */
type ReservationRevenueFilter = {
  paymentMethod?: string;
  cashSessionId?: string;
  vehicleType?: string;
  vehicleCategory?: string;
};

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

function confidenceFor(samples: number): ProjectionConfidence {
  if (samples >= 6) return 'high';
  if (samples >= 3) return 'medium';
  return 'low';
}

/**
 * The optional vehicle filters, as a `where` fragment.
 *
 * `vehicleCategory` is the one to use: `entries.vehicleCategory` is the
 * platform category frozen at ingress (`20261005120200`), filled on manual and
 * LPR stays alike, and it groups "Autos", "Auto" and "Coche" together.
 *
 * `vehicleType` is deprecated for one version. `entries.vehicleType` is a
 * **text snapshot** of the type name taken at ingress, not a foreign key into
 * `vehicle_types` (see `20260901012009_entries_vehicle_type_snapshot.sql`): a
 * stay from eight months ago must not change meaning because the owner renamed
 * or deleted the type. So the match is a plain string equality against that
 * snapshot, and the filter is deliberately *not* validated against the tenant's
 * live catalogue — doing so would reject a perfectly legitimate query for a
 * type that has since been renamed away.
 *
 * If both are sent, both must match.
 */
function vehicleWhere(filter: {
  vehicleType?: string;
  vehicleCategory?: string;
}): {
  vehicleType?: string;
  vehicleCategory?: string;
} {
  return {
    ...(filter.vehicleType ? { vehicleType: filter.vehicleType } : {}),
    ...(filter.vehicleCategory
      ? { vehicleCategory: filter.vehicleCategory }
      : {}),
  };
}

/**
 * The optional cash-session filter, for queries rooted at
 * `payment_transactions`. Top-level on the transaction, so the tenant scope
 * already covers it and the `(tenant_id, cash_session_id)` index applies.
 */
function transactionSessionWhere(cashSessionId?: string): {
  cashSessionId?: string;
} {
  return cashSessionId ? { cashSessionId } : {};
}

/**
 * Every read of `payment_transactions` has to exclude tombstones.
 *
 * Correcting a stay's payment breakdown does not rewrite the rows: it marks the
 * old ones `deleted_at` and inserts the new ones, so incremental sync can tell
 * each desktop to drop its stale copies
 * (`20260908090000_soft_delete_payment_transactions.sql`). Summing without this
 * filter counts a corrected payment twice — once at the old amount and once at
 * the new — and the pie stops reconciling with `entries.amountPaid`, which the
 * correction *does* overwrite.
 */
const LIVE_PAYMENT = { deletedAt: null } as const;

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

    const [
      occupancy,
      today,
      previousDay,
      previousWeek,
      pendingLprEvents,
      openPortfolio,
      monthRevenue,
    ] = await Promise.all([
      this.computeOccupancy(),
      this.dayTotals(day, tz, elapsedMs),
      this.dayTotals(previousDayKey, tz, elapsedMs),
      this.dayTotals(previousWeekKey, tz, elapsedMs),
      tenantPrisma.lprDetectionEvent.count({
        where: { status: LprDetectionStatus.pending, archivedAt: null },
      }),
      this.openEntriesProjection(generatedAt),
      this.monthToDateRevenue(day, tz, generatedAt),
    ]);

    const [todayHistoricalForecast, monthHistoricalForecast] =
      await Promise.all([
        this.todayHistoricalForecast(day, tz, elapsedMs, today.revenue),
        this.monthHistoricalForecast(day, tz, monthRevenue),
      ]);

    const todayWithOpenEntries = this.projection(
      today.revenue + openPortfolio.value,
      openPortfolio.count,
      0,
    );
    const monthWithOpenEntries = this.projection(
      monthRevenue + openPortfolio.value,
      openPortfolio.count,
      0,
    );

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
      projections: {
        todayWithOpenEntries,
        todayHistoricalForecast,
        monthWithOpenEntries,
        monthHistoricalForecast,
      },
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
    const { from, to } = await this.resolveWindow(query, REVENUE_INSTANCE);

    if (exceedsBucketLimit(from, to, granularity)) {
      throw this.badWindow(
        REVENUE_INSTANCE,
        `This range at '${granularity}' granularity exceeds the ${MAX_BUCKETS}-bucket limit. Widen the granularity or shorten the range.`,
      );
    }

    const buckets = bucketRange(from, to, granularity, tz);
    // The per-method split and the collecting drawer both exist only on the
    // transactions, so either filter moves revenue off `entries.amountPaid`.
    const revenueSource: RevenueSource =
      query.paymentMethod || query.cashSessionId
        ? 'paymentTransactions'
        : 'entries';

    const [exits, arrivals, reservationRows] = await Promise.all([
      this.loadExits(from, to, query),
      this.loadArrivals(from, to, query),
      this.loadReservationRevenue(from, to, query),
    ]);

    const rows: RevenueBucketDto[] = buckets.map((bucket) => ({
      key: bucket.key,
      from: bucket.gte,
      to: bucket.lt,
      revenue: 0,
      reservationRevenue: 0,
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
    // Reservation money adds to the bucket of its own date, and is also
    // reported apart so a client can tell it from till revenue.
    for (const row of reservationRows) {
      const index = indexOfBucket(buckets, row.at);
      if (index === -1) continue;
      rows[index].revenue += row.amount;
      rows[index].reservationRevenue += row.amount;
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
        reservationRevenue: roundMoney(
          rows.reduce((sum, r) => sum + r.reservationRevenue, 0),
        ),
        vehiclesIn: arrivals.length,
        vehiclesOut: rows.reduce((sum, r) => sum + r.vehiclesOut, 0),
      },
      buckets: rows.map((row) => ({
        ...row,
        revenue: roundMoney(row.revenue),
        reservationRevenue: roundMoney(row.reservationRevenue),
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
    const { from, to } = await this.resolveWindow(query, BREAKDOWN_INSTANCE);
    const leftAt = { gte: from, lt: to };

    const [authoritative, groups, reservationRows] = await Promise.all([
      tenantPrisma.entry.aggregate({
        _sum: { amountPaid: true },
        where: {
          leftAt,
          ...vehicleWhere(query),
          // With a session: the stays it collected. A close writes all of its
          // payments under one session, so their `amountPaid` equals the
          // transactions' sum, `unallocated` comes out 0, and the pie
          // reconciles with the revenue chart for the same shift.
          ...this.paymentsWhere({ cashSessionId: query.cashSessionId }),
        },
      }),
      tenantPrisma.paymentTransaction.groupBy({
        by: ['paymentMethodName'],
        _sum: { amount: true },
        _count: { _all: true },
        where: {
          ...LIVE_PAYMENT,
          ...transactionSessionWhere(query.cashSessionId),
          entry: {
            // See `loadExits`: the tenant scope does not reach into a nested
            // relation filter, and without it the range cannot use the index.
            tenantId: this.tenantContext.getTenantIdOrThrow(),
            leftAt,
            ...vehicleWhere(query),
          },
        },
      }),
      this.loadReservationRevenue(from, to, query),
    ]);

    const reservationAmount = roundMoney(
      reservationRows.reduce((sum, row) => sum + row.amount, 0),
    );
    const total = roundMoney(
      Number(authoritative._sum.amountPaid ?? 0) + reservationAmount,
    );
    const methods: PaymentMethodSliceDto[] = groups.map((group) => ({
      name: group.paymentMethodName,
      kind: 'payment',
      amount: roundMoney(Number(group._sum.amount ?? 0)),
      count: group._count._all,
      share: null,
    }));
    // Reservation money has its own bucket: it is paid online, not at the
    // till, and it must not read as `unallocated`.
    if (reservationRows.length > 0) {
      methods.push({
        name: RESERVATION_PAYMENT_METHOD,
        kind: 'reservation',
        amount: reservationAmount,
        count: reservationRows.length,
        share: null,
      });
    }
    methods.sort((a, b) => b.amount - a.amount);

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
    const { from, to } = await this.resolveWindow(query, TOP_PLATES_INSTANCE);
    const orderBy: TopPlatesOrder = query.orderBy ?? 'revenue';
    const limit = query.limit ?? DEFAULT_TOP_PLATES;

    const stays = await tenantPrisma.entry.findMany({
      where: {
        leftAt: { gte: from, lt: to },
        ...vehicleWhere(query),
        ...(await this.staysOfSessionWhere(query.cashSessionId)),
      },
      select: {
        plate: true,
        enteredAt: true,
        leftAt: true,
        amountPaid: true,
        prepaidAmountArs: true,
      },
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
      bucket.revenue +=
        Number(stay.amountPaid ?? 0) + Number(stay.prepaidAmountArs ?? 0);
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
   * The effective `[from, to)` of an analytical query.
   *
   * Without a cash session it is the `from`/`to` pair, whose offset
   * `@IsOffsetDateTime` already enforced — all that is left is ordering.
   *
   * With one, the session must exist in this tenant, even when `from`/`to`
   * came too: a mistyped id should fail loudly rather than chart a shift of
   * zeros. A bound the caller sent is used verbatim; a missing one is derived
   * from the session, see `sessionSpan`.
   */
  private async resolveWindow(
    query: MetricsWindowQueryDto,
    instance: string,
  ): Promise<{ from: Date; to: Date }> {
    let from = query.from !== undefined ? new Date(query.from) : undefined;
    let to = query.to !== undefined ? new Date(query.to) : undefined;

    if (query.cashSessionId) {
      const session = await this.findCashSession(query.cashSessionId, instance);
      if (!from || !to) {
        const span = await this.sessionSpan(session);
        from = from ?? span.from;
        to = to ?? span.to;
      }
    }

    // Unreachable over HTTP — the DTO requires both bounds without a session —
    // but it keeps the contract honest for direct callers.
    if (!from || !to) {
      throw this.badWindow(
        instance,
        '`from` and `to` are required unless `cashSessionId` is given.',
      );
    }
    if (from >= to) {
      throw this.badWindow(instance, '`from` must be earlier than `to`.');
    }
    return { from, to };
  }

  /**
   * A cash session of this tenant, or a 404.
   *
   * The read is tenant-scoped, so another lot's session is simply not found:
   * the same answer as a nonexistent id, which tells a caller nothing about
   * what exists elsewhere.
   */
  private async findCashSession(
    id: string,
    instance: string,
  ): Promise<SessionBounds> {
    const session = await this.prisma.getTenantClient().cashSession.findFirst({
      where: { id },
      select: { id: true, openedAt: true, closedAt: true },
    });
    if (!session) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Cash session not found.',
        instance,
        ErrorCodes.CASH_SESSION_NOT_FOUND,
      );
    }
    return session;
  }

  /**
   * The window a cash session's figures live in: the shift itself, widened to
   * cover every payment the session collected. An open shift runs until now.
   *
   * The widening is the reason to filter by session at all. The desktop is
   * offline-first and syncs closes later with an explicit `cashSessionId`, so
   * a payment's `leftAt` can fall outside the `openedAt`–`closedAt` of the very
   * session that collected it. Clipping to the shift would drop it from the
   * buckets — exactly the error of approximating a session by its clock
   * window. Widened, the totals are the exact sum of the session's payments.
   */
  private async sessionSpan(
    session: SessionBounds,
  ): Promise<{ from: Date; to: Date }> {
    const paid = await this.prisma.getTenantClient().entry.aggregate({
      _min: { leftAt: true },
      _max: { leftAt: true },
      where: this.paymentsWhere({ cashSessionId: session.id }),
    });
    const firstPaid = paid._min?.leftAt ?? null;
    const lastPaid = paid._max?.leftAt ?? null;
    const end = session.closedAt ?? new Date();

    const from =
      firstPaid && firstPaid < session.openedAt ? firstPaid : session.openedAt;
    // `to` is exclusive, so the last payment needs one millisecond of room to
    // land inside the final bucket.
    const pastLastPaid = lastPaid ? new Date(lastPaid.getTime() + 1) : null;
    const to = pastLastPaid && pastLastPaid > end ? pastLastPaid : end;
    return { from, to };
  }

  /**
   * A filter on the stay's payments, for queries rooted at `entries`.
   *
   * The session match is on `payment_transactions.cash_session_id` — the
   * drawer that **collected** the money. Never `entries.cash_session_id`: that
   * one records the drawer a car entered under, and closing a shift moves it to
   * the next one for every car still inside
   * (`CashSessionsService.closeSession`). Summing a shift by it would put
   * carried-over cars in the wrong drawer.
   *
   * Method and session share one `some`, so "paid in cash during this shift"
   * means a single transaction satisfying both, not two unrelated ones.
   */
  private paymentsWhere(filters: {
    paymentMethod?: string;
    cashSessionId?: string;
  }): Prisma.EntryWhereInput {
    const some: Prisma.PaymentTransactionWhereInput = {};
    if (filters.paymentMethod) some.paymentMethodName = filters.paymentMethod;
    if (filters.cashSessionId) {
      some.cashSessionId = filters.cashSessionId;
      // The tenant scope does not reach into a nested filter (see
      // `loadExits`); restated, the `(tenant_id, cash_session_id)` index
      // applies.
      some.tenantId = this.tenantContext.getTenantIdOrThrow();
    }
    // The tombstone clause goes in last, and only once something else is
    // filtering: an empty `some` means "no payment filter at all", and adding
    // `deletedAt` up front would make every query look filtered.
    return Object.keys(some).length > 0
      ? { paymentTransactions: { some: { ...some, ...LIVE_PAYMENT } } }
      : {};
  }

  /**
   * Stays that ended in the window, as `{ at: leftAt, amount }` pairs.
   *
   * Without a payment-method or cash-session filter the amount is the stay's
   * own `amountPaid`. With either, it comes from the matching
   * `payment_transactions` instead — a stay can split a single exit across
   * cash and transfer, so charging the whole `amountPaid` to one method would
   * overstate it, and the collecting drawer is recorded only there. Each
   * transaction is counted as its own exit row, then de-duplicated per bucket
   * by entry id.
   */
  private async loadExits(
    from: Date,
    to: Date,
    query: RevenueQueryDto,
  ): Promise<{ at: Date; amount: number; entryId: string }[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const leftAt = { gte: from, lt: to };

    if (!query.paymentMethod && !query.cashSessionId) {
      const entries = await tenantPrisma.entry.findMany({
        where: { leftAt, ...vehicleWhere(query) },
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
        ...LIVE_PAYMENT,
        ...(query.paymentMethod
          ? { paymentMethodName: query.paymentMethod }
          : {}),
        ...transactionSessionWhere(query.cashSessionId),
        entry: {
          // `prismaForTenant` injects `tenantId` at the top level only, so a
          // nested relation filter reaches `entries` without one. Correctness
          // is unaffected (a transaction's entry is always same-tenant, by FK
          // and RLS), but the planner then cannot use the composite
          // `(tenant_id, left_at)` index and falls back to a full scan of
          // `entries`. Restating the tenant here keeps the index in play.
          tenantId: this.tenantContext.getTenantIdOrThrow(),
          leftAt,
          ...vehicleWhere(query),
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
        ...vehicleWhere(query),
        // With a method or session filter, "vehicles in" means the stays that
        // ended up paying that way — otherwise the two series would answer
        // different questions on the same chart.
        ...this.paymentsWhere(query),
      },
      select: { enteredAt: true },
    });
    return entries.map((entry) => entry.enteredAt);
  }

  /**
   * Reservation money recognised in `[from, to)` — the single place that
   * decides it (accrual basis, see `ReservationRevenueRow`).
   *
   * Filters: a `paymentMethod` other than the reservation bucket excludes it
   * all; a `cashSessionId` keeps only the prepayment of the stays that left
   * under that drawer (a no-show or a cancellation is no drawer event); the
   * deprecated `vehicleType` (an entry text snapshot) cannot match a
   * reservation that never became a stay, so it drops those too.
   */
  private async loadReservationRevenue(
    from: Date,
    to: Date,
    filter: ReservationRevenueFilter,
  ): Promise<ReservationRevenueRow[]> {
    if (
      filter.paymentMethod &&
      filter.paymentMethod !== RESERVATION_PAYMENT_METHOD
    ) {
      return [];
    }
    const [prepaid, reservationOnly] = await Promise.all([
      this.loadPrepaidRows(from, to, filter),
      this.loadUnusedReservationRows(from, to, filter),
    ]);
    return [...prepaid, ...reservationOnly];
  }

  /**
   * Reservation money that never became a stay (no-show, partial cancel), under
   * the same filters as `loadReservationRevenue` so every chart agrees. A
   * `paymentMethod` other than the reservation bucket, a cash session (a
   * no-show is no drawer event) or the deprecated `vehicleType` drop it.
   */
  private async loadUnusedReservationRows(
    from: Date,
    to: Date,
    filter: ReservationRevenueFilter,
  ): Promise<ReservationRevenueRow[]> {
    if (
      (filter.paymentMethod &&
        filter.paymentMethod !== RESERVATION_PAYMENT_METHOD) ||
      filter.cashSessionId ||
      filter.vehicleType
    ) {
      return [];
    }
    return this.loadReservationOnlyRows(from, to, filter.vehicleCategory);
  }

  /**
   * SINGLE RULE (shared with web and desktop) for which stays' reservation
   * prepayment belongs to a cash session: it is credited when the car EXITS, so
   * it belongs to the session the car exited under.
   *  1. The stay has payments: the exit session is the one its payments were
   *     collected under (`payment_transactions.cashSessionId`).
   *  2. No payments (a $0 exit, fully covered by the prepayment): fall back to
   *     the shift window, `leftAt ∈ [openedAt, closedAt ?? now)`. A tenant has
   *     at most one open session (`CashSessionsService.createSession`), so the
   *     windows never overlap.
   * Never `entries.cashSessionId`: it is the entry drawer and gets reassigned
   * when a shift closes.
   */
  private prepaidSessionBranches(
    session: SessionBounds,
  ): Prisma.EntryWhereInput[] {
    return [
      this.paymentsWhere({ cashSessionId: session.id }),
      {
        paymentTransactions: {
          none: {
            tenantId: this.tenantContext.getTenantIdOrThrow(),
            cashSessionId: { not: null },
            ...LIVE_PAYMENT,
          },
        },
        leftAt: { gte: session.openedAt, lt: session.closedAt ?? new Date() },
      },
    ];
  }

  /**
   * Stays that belong to a cash session under the single rule of
   * `prepaidSessionBranches` (live payments' session, else the shift window of
   * `leftAt`), so a $0 exit covered by a reservation prepayment is not lost.
   * No session: no filter.
   */
  private async staysOfSessionWhere(
    cashSessionId?: string,
  ): Promise<Prisma.EntryWhereInput> {
    if (!cashSessionId) return {};
    const session = await this.findCashSession(
      cashSessionId,
      BREAKDOWN_INSTANCE,
    );
    return { OR: this.prepaidSessionBranches(session) };
  }

  /** The prepayment of stays that left in the window (they came). */
  private async loadPrepaidRows(
    from: Date,
    to: Date,
    filter: ReservationRevenueFilter,
  ): Promise<ReservationRevenueRow[]> {
    const session = filter.cashSessionId
      ? await this.findCashSession(filter.cashSessionId, BREAKDOWN_INSTANCE)
      : null;
    const entries = await this.prisma.getTenantClient().entry.findMany({
      where: {
        leftAt: { gte: from, lt: to },
        prepaidAmountArs: { gt: 0 },
        ...vehicleWhere(filter),
        ...(session ? { OR: this.prepaidSessionBranches(session) } : {}),
      },
      select: { leftAt: true, prepaidAmountArs: true },
    });
    return entries.map((entry) => ({
      at: entry.leftAt as Date,
      amount: Number(entry.prepaidAmountArs ?? 0),
      kind: 'prepaid' as const,
    }));
  }

  /** Paid reservations that never became a stay: no-show and partial cancel. */
  private async loadReservationOnlyRows(
    from: Date,
    to: Date,
    vehicleCategory?: string,
  ): Promise<ReservationRevenueRow[]> {
    const range = { gte: from, lt: to };
    const reservations = await this.prisma
      .getTenantClient()
      .reservation.findMany({
        where: {
          ...(vehicleCategory ? { vehicleCategory } : {}),
          OR: [
            // A late arrival still links an entry: that money is `prepaid`.
            {
              status: ReservationStatus.no_show,
              entryAt: range,
              entry: null,
            },
            { status: ReservationStatus.cancelled, cancelledAt: range },
          ],
        },
        select: {
          status: true,
          entryAt: true,
          cancelledAt: true,
          totalArs: true,
          paidAt: true,
          refundStatus: true,
          refundedAmountArs: true,
          refundRequestedArs: true,
          payments: {
            where: { status: ReservationPaymentStatus.approved },
            select: { amountArs: true },
          },
        },
      });

    const rows: ReservationRevenueRow[] = [];
    for (const reservation of reservations) {
      const paid = prepaidAmountOf(reservation);
      // A refund still in flight is money already going back.
      const refunded = Number(
        (reservation.refundStatus === 'pending'
          ? reservation.refundRequestedArs
          : reservation.refundedAmountArs) ?? 0,
      );
      const kept = roundMoney(paid - refunded);
      if (kept <= 0) continue;
      const isNoShow = reservation.status === ReservationStatus.no_show;
      rows.push({
        at: (isNoShow ? reservation.entryAt : reservation.cancelledAt) as Date,
        amount: kept,
        kind: isNoShow ? 'no_show' : 'retained',
      });
    }
    return rows;
  }

  /** Sum of the no-show and partial-cancel money in `[from, to)`. */
  private async reservationOnlyTotal(from: Date, to: Date): Promise<number> {
    const rows = await this.loadReservationOnlyRows(from, to);
    return rows.reduce((sum, row) => sum + row.amount, 0);
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

    const [occupancy, groups, categoryGroups] = await Promise.all([
      this.computeOccupancy(),
      tenantPrisma.entry.groupBy({
        by: ['vehicleType'],
        _count: { _all: true },
        where: { leftAt: null },
      }),
      tenantPrisma.entry.groupBy({
        by: ['vehicleCategory'],
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

    const byVehicleCategory = categoryGroups
      .map((group) => ({
        category: toVehicleCategory(group.vehicleCategory),
        occupied: group._count._all,
      }))
      .sort(byCountWithUnknownLast((row) => row.category, 'occupied'));

    return { ...occupancy, byVehicleType, byVehicleCategory };
  }

  /**
   * Stays that ended in the window, split by platform vehicle category (pie
   * chart). Groups on `entries.vehicleCategory`, the category frozen at
   * ingress, so changing a type's category later does not rewrite history.
   * Stays without one (they predate the categories, or came from an old till)
   * are the `null` slice: the slices always add up to the window's total.
   */
  async getVehicleCategoryBreakdown(
    query: MetricsWindowQueryDto,
  ): Promise<VehicleCategoryBreakdownDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const { from, to } = await this.resolveWindow(
      query,
      VEHICLE_CATEGORY_INSTANCE,
    );

    const [groups, unusedRows] = await Promise.all([
      tenantPrisma.entry.groupBy({
        by: ['vehicleCategory'],
        _count: { _all: true },
        _sum: { amountPaid: true, prepaidAmountArs: true },
        where: {
          leftAt: { gte: from, lt: to },
          ...vehicleWhere(query),
          ...(await this.staysOfSessionWhere(query.cashSessionId)),
        },
      }),
      this.loadUnusedReservationRows(from, to, query),
    ]);

    const totalStays = groups.reduce((sum, g) => sum + g._count._all, 0);
    const categories = groups
      .map((group) => ({
        category: toVehicleCategory(group.vehicleCategory),
        stays: group._count._all,
        // Till revenue plus the reservation prepayment of those stays.
        revenue: roundMoney(
          Number(group._sum.amountPaid ?? 0) +
            Number(group._sum.prepaidAmountArs ?? 0),
        ),
        share:
          totalStays > 0 ? roundRatio(group._count._all / totalStays) : null,
      }))
      .sort(byCountWithUnknownLast((row) => row.category, 'stays'));

    // Reservation money with no stay behind it (no-show, partial cancel) has no
    // category of its own; it closes the gap with `revenue/by-payment-method`.
    const unusedAmount = roundMoney(
      unusedRows.reduce((sum, row) => sum + row.amount, 0),
    );
    const result: VehicleCategorySliceDto[] = [...categories];
    if (unusedAmount > 0) {
      result.push({
        category: RESERVATION_UNUSED_CATEGORY,
        stays: 0,
        revenue: unusedAmount,
        share: totalStays > 0 ? 0 : null,
      });
    }

    return {
      from,
      to,
      currency: CURRENCY,
      totalStays,
      totalRevenue: roundMoney(
        result.reduce((sum, row) => sum + row.revenue, 0),
      ),
      categories: result,
    };
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
  private async computeOccupancy(now = new Date()): Promise<OccupancyDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const [tenant, occupied, todaysReservations] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      }),
      tenantPrisma.entry.count({ where: { leftAt: null } }),
      // Reservas de hoy que retienen un lugar hasta que el auto entra. Con el
      // auto adentro (checked_in) lo cuenta su ingreso: así "Libres ahora"
      // baja en 1 y no en 2. Misma regla que la app del conductor.
      tenantPrisma.reservation.findMany({
        where: reservedTodayWhere(now),
        select: RESERVED_HELD_SELECT,
      }),
    ]);

    const capacity = readCapacity(tenant?.settings ?? {}).total;
    const reservedHeld = countReservedHeld(todaysReservations, now);

    return {
      capacity,
      occupied,
      reservedHeld,
      // Floored at 0: a lot can hold more vehicles than its configured spots.
      free:
        capacity > 0 ? Math.max(capacity - occupied - reservedHeld, 0) : null,
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

    const [closed, reservationOnly, vehiclesIn] = await Promise.all([
      tenantPrisma.entry.aggregate({
        _sum: { amountPaid: true, prepaidAmountArs: true },
        _count: true,
        where: { leftAt: { gte, lt } },
      }),
      this.reservationOnlyTotal(gte, lt),
      tenantPrisma.entry.count({ where: { enteredAt: { gte, lt } } }),
    ]);
    const reservationRevenue =
      Number(closed._sum.prepaidAmountArs ?? 0) + reservationOnly;

    return {
      day: dayKey,
      revenue: Number(closed._sum.amountPaid ?? 0) + reservationRevenue,
      reservationRevenue: roundMoney(reservationRevenue),
      vehiclesIn,
      vehiclesOut: closed._count,
    };
  }

  private projection(
    value: number,
    openEntries: number,
    historicalDays: number,
  ): RevenueProjectionDto {
    return {
      value: roundMoney(value),
      openEntries,
      historicalDays,
      confidence: confidenceFor(historicalDays),
    };
  }

  private async openEntriesProjection(
    asOf: Date,
  ): Promise<{ value: number; count: number }> {
    const rows = await this.prisma.getTenantClient().entry.findMany({
      where: { leftAt: null },
      select: {
        enteredAt: true,
        rateSnapshotHourPriceArs: true,
        rateSnapshotStayPriceArs: true,
        rateSnapshotFractionPriceArs: true,
        rateSnapshotMediaEstadiaPriceArs: true,
      },
    });

    const value = rows.reduce((sum, entry) => {
      const elapsedMinutes =
        (asOf.getTime() - entry.enteredAt.getTime()) / MS_PER_MINUTE;
      return (
        sum +
        calcStayPrice(elapsedMinutes, {
          hour: Number(entry.rateSnapshotHourPriceArs ?? 0),
          stay: Number(entry.rateSnapshotStayPriceArs ?? 0),
          fraction: Number(entry.rateSnapshotFractionPriceArs ?? 0),
          mediaEstadia: Number(entry.rateSnapshotMediaEstadiaPriceArs ?? 0),
        })
      );
    }, 0);

    return { value: roundMoney(value), count: rows.length };
  }

  private async fullDayRevenue(dayKey: DayKey, tz: string): Promise<number> {
    const { gte, lt } = partialDayRangeIn(dayKey, tz, Number.MAX_SAFE_INTEGER);
    const [result, reservationOnly] = await Promise.all([
      this.prisma.getTenantClient().entry.aggregate({
        _sum: { amountPaid: true, prepaidAmountArs: true },
        where: { leftAt: { gte, lt } },
      }),
      this.reservationOnlyTotal(gte, lt),
    ]);
    return (
      Number(result._sum.amountPaid ?? 0) +
      Number(result._sum.prepaidAmountArs ?? 0) +
      reservationOnly
    );
  }

  private async monthToDateRevenue(
    dayKey: DayKey,
    tz: string,
    asOf: Date,
  ): Promise<number> {
    const monthStart = `${dayKey.slice(0, 8)}01`;
    const from = partialDayRangeIn(monthStart, tz, 0).gte;
    const [result, reservationOnly] = await Promise.all([
      this.prisma.getTenantClient().entry.aggregate({
        _sum: { amountPaid: true, prepaidAmountArs: true },
        where: { leftAt: { gte: from, lt: asOf } },
      }),
      this.reservationOnlyTotal(from, asOf),
    ]);
    return (
      Number(result._sum.amountPaid ?? 0) +
      Number(result._sum.prepaidAmountArs ?? 0) +
      reservationOnly
    );
  }

  private async todayHistoricalForecast(
    dayKey: DayKey,
    tz: string,
    elapsedMs: number,
    todayRevenue: number,
  ): Promise<RevenueProjectionDto> {
    const samples: number[] = [];

    for (
      let cursor = shiftDayKey(dayKey, -7);
      samples.length < HISTORICAL_WEEKDAY_SAMPLES;
      cursor = shiftDayKey(cursor, -7)
    ) {
      const partial = await this.dayTotals(cursor, tz, elapsedMs);
      const full = await this.fullDayRevenue(cursor, tz);
      if (partial.revenue > 0 && full >= partial.revenue) {
        samples.push(full / partial.revenue);
      }
      if (cursor < shiftDayKey(dayKey, -7 * 24)) break;
    }

    if (samples.length === 0 || todayRevenue === 0) {
      return this.projection(todayRevenue, 0, samples.length);
    }

    const factor =
      samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    return this.projection(todayRevenue * factor, 0, samples.length);
  }

  private async monthHistoricalForecast(
    dayKey: DayKey,
    tz: string,
    monthRevenue: number,
  ): Promise<RevenueProjectionDto> {
    const remainingDays = this.remainingDaysInMonth(dayKey);
    let projectedRemainder = 0;
    let samples = 0;

    for (const remaining of remainingDays) {
      const sameWeekday: number[] = [];
      // Only fully elapsed days are history. Walking back from a day late in
      // the month lands on today (still open, so a partial total) or on other
      // future days; step over those instead of sampling them.
      let first = shiftDayKey(remaining, -7);
      while (first >= dayKey) first = shiftDayKey(first, -7);
      for (
        let cursor = first;
        sameWeekday.length < MONTH_REMAINING_WEEKDAY_SAMPLES;
        cursor = shiftDayKey(cursor, -7)
      ) {
        const revenue = await this.fullDayRevenue(cursor, tz);
        if (revenue > 0) sameWeekday.push(revenue);
        if (cursor < shiftDayKey(dayKey, -7 * 24)) break;
      }
      if (sameWeekday.length === 0) continue;
      samples += sameWeekday.length;
      projectedRemainder +=
        sameWeekday.reduce((sum, revenue) => sum + revenue, 0) /
        sameWeekday.length;
    }

    return this.projection(monthRevenue + projectedRemainder, 0, samples);
  }

  private remainingDaysInMonth(dayKey: DayKey): DayKey[] {
    const [year, month] = dayKey.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const currentDay = Number(dayKey.slice(8, 10));
    const days: DayKey[] = [];
    for (let day = currentDay + 1; day <= daysInMonth; day++) {
      days.push(`${dayKey.slice(0, 8)}${String(day).padStart(2, '0')}`);
    }
    return days;
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
