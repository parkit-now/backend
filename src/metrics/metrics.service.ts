import { Injectable } from '@nestjs/common';
import { LprDetectionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { readCapacity } from '../entities/entity-settings';
import { MetricsTzQueryDto } from './dto/metrics-tz-query.dto';
import {
  CapacitySource,
  OccupancyDto,
  OccupancyResponseDto,
} from './dto/occupancy-response.dto';
import {
  DayComparisonDto,
  DayTotalsDto,
  MetricsSummaryDto,
} from './dto/summary-response.dto';
import {
  DEFAULT_TIME_ZONE,
  DayKey,
  dayKeyIn,
  partialDayRangeIn,
  shiftDayKey,
} from './metrics-tz';

/** Bucket label for open entries that never declared a vehicle type. */
const UNKNOWN_VEHICLE_TYPE = 'unknown';

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
