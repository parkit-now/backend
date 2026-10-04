import { ApiProperty } from '@nestjs/swagger';
import { OccupancyDto } from './occupancy-response.dto';

/** Headline numbers for one civil day. */
export class DayTotalsDto {
  @ApiProperty({
    description:
      'Civil day these totals cover, `YYYY-MM-DD` in the requested timezone.',
    example: '2026-08-27',
  })
  day: string;

  @ApiProperty({
    type: Number,
    description:
      'Sum of `amountPaid` over entries closed in the window plus `reservationRevenue`, in ARS. Till revenue counts at exit time, since payments carry no timestamp of their own.',
    example: 184500,
  })
  revenue: number;

  @ApiProperty({
    type: Number,
    description:
      'Portion of `revenue` paid online for reservations (prepayment of stays that left in the window, no-shows and partially kept cancellations dated in the window), in ARS.',
    example: 3000,
  })
  reservationRevenue: number;

  @ApiProperty({
    type: 'integer',
    description: 'Entries whose `enteredAt` falls in the window.',
    example: 71,
  })
  vehiclesIn: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Entries whose `leftAt` falls in the window (exits, i.e. charged stays).',
    example: 63,
  })
  vehiclesOut: number;
}

/**
 * A past day measured against today, for the dashboard's comparison chart.
 *
 * Baselines are truncated to the same elapsed offset within the day as today
 * has run so far — comparing a full previous day against today-at-09:00 would
 * paint a collapse every morning.
 */
export class DayComparisonDto extends DayTotalsDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Relative change of today vs this baseline (`(today - base) / base`). `null` when the baseline is 0, so the client renders "sin datos" instead of an infinite jump.',
    example: 0.153,
  })
  revenueDeltaPct: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Relative change of `vehiclesIn` vs this baseline. `null` when the baseline is 0.',
    example: 0.092,
  })
  vehiclesInDeltaPct: number | null;
}

/** Day-over-day and week-over-week baselines. */
export class SummaryComparisonDto {
  @ApiProperty({
    type: DayComparisonDto,
    description: 'Yesterday, truncated to the same elapsed offset as today.',
  })
  previousDay: DayComparisonDto;

  @ApiProperty({
    type: DayComparisonDto,
    description:
      'Same weekday one week back, truncated to the same elapsed offset. Weekday-aligned because parking demand swings hard between weekdays and weekends.',
  })
  previousWeek: DayComparisonDto;
}

/** Operational items awaiting the owner's attention. */
export class SummaryAlertsDto {
  @ApiProperty({
    type: 'integer',
    description:
      'Unreviewed, non-archived LPR detections (`status = pending`). Detail lives at `GET /tenants/:tenantId/lpr-events?status=pending`.',
    example: 4,
  })
  pendingLprEvents: number;
}

export type ProjectionConfidence = 'low' | 'medium' | 'high';

export class RevenueProjectionDto {
  @ApiProperty({
    type: Number,
    description:
      'Projected revenue in ARS. Orientative, not an accounting total.',
    example: 245000,
  })
  value: number;

  @ApiProperty({
    type: 'integer',
    description: 'Open entries included in the projection.',
    example: 8,
  })
  openEntries: number;

  @ApiProperty({
    type: 'integer',
    description: 'Historical days used by the trend model.',
    example: 6,
  })
  historicalDays: number;

  @ApiProperty({
    enum: ['low', 'medium', 'high'],
    description: 'Confidence level based on the amount of historical data.',
    example: 'medium',
  })
  confidence: ProjectionConfidence;
}

export class MetricsProjectionsDto {
  @ApiProperty({ type: RevenueProjectionDto })
  todayWithOpenEntries: RevenueProjectionDto;

  @ApiProperty({ type: RevenueProjectionDto })
  todayHistoricalForecast: RevenueProjectionDto;

  @ApiProperty({ type: RevenueProjectionDto })
  monthWithOpenEntries: RevenueProjectionDto;

  @ApiProperty({ type: RevenueProjectionDto })
  monthHistoricalForecast: RevenueProjectionDto;
}

/**
 * Response of `GET /tenants/:tenantId/metrics/summary` — every KPI the owner
 * dashboard renders above the fold, in a single request.
 *
 * Deliberately one call rather than five: owners with several lots fan out one
 * request per lot and merge client-side, so the per-lot request count is what
 * bounds the dashboard's load time.
 */
export class MetricsSummaryDto {
  @ApiProperty({
    description: 'IANA timezone the civil days were computed in.',
    example: 'America/Argentina/Buenos_Aires',
  })
  tz: string;

  @ApiProperty({
    description: 'Current civil day in `tz`, `YYYY-MM-DD`.',
    example: '2026-08-27',
  })
  day: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Instant the snapshot was taken. Also the upper bound of the "today" window and the offset the baselines are truncated to.',
  })
  generatedAt: Date;

  @ApiProperty({
    type: OccupancyDto,
    description: 'Live occupancy at `generatedAt`.',
  })
  occupancy: OccupancyDto;

  @ApiProperty({
    type: DayTotalsDto,
    description:
      'Totals from the start of the current civil day up to `generatedAt`.',
  })
  today: DayTotalsDto;

  @ApiProperty({ type: SummaryComparisonDto })
  comparison: SummaryComparisonDto;

  @ApiProperty({ type: SummaryAlertsDto })
  alerts: SummaryAlertsDto;

  @ApiProperty({ type: MetricsProjectionsDto })
  projections: MetricsProjectionsDto;
}
