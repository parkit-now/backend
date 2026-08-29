import { ApiProperty } from '@nestjs/swagger';
import type { Granularity } from '../metrics-tz';

/**
 * Which table the `revenue` figures were summed from.
 *
 * `entries` is the default and the authoritative total per stay. Filtering by
 * payment method forces `paymentTransactions`, the only place the per-method
 * split lives — and a narrower source, since stays closed through the offline
 * `amountPaid` fallback never produced transaction rows.
 */
export type RevenueSource = 'entries' | 'paymentTransactions';

/** Totals over one bucket of the series. */
export class RevenueBucketDto {
  @ApiProperty({
    description:
      'Bucket label in `tz`: `YYYY-MM-DDTHH` (hour), `YYYY-MM-DD` (day, and week labelled by its Monday) or `YYYY-MM` (month).',
    example: '2026-08-07',
  })
  key: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Start of the bucket (inclusive). Clipped to the requested window, so the first bucket often starts mid-period.',
  })
  from: Date;

  @ApiProperty({
    format: 'date-time',
    description:
      'End of the bucket (exclusive). Clipped to the requested window.',
  })
  to: Date;

  @ApiProperty({
    type: Number,
    description:
      'Revenue attributed to this bucket, in ARS. Anchored on `leftAt`.',
    example: 12300,
  })
  revenue: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Stays that **entered** during this bucket. Anchored on `enteredAt`.',
    example: 21,
  })
  vehiclesIn: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Stays that **left** during this bucket. Anchored on `leftAt`.',
    example: 19,
  })
  vehiclesOut: number;
}

/** Response of `GET /tenants/:tenantId/metrics/revenue`. */
export class RevenueResponseDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Resolved start of the window.',
  })
  from: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'Resolved end of the window.',
  })
  to: Date;

  @ApiProperty({
    description: 'Timezone the buckets were aligned to.',
    example: 'America/Argentina/Buenos_Aires',
  })
  tz: string;

  @ApiProperty({
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Bucket width used.',
    example: 'day',
  })
  granularity: Granularity;

  @ApiProperty({
    enum: ['entries', 'paymentTransactions'],
    description:
      'Table the revenue was summed from. Switches to `paymentTransactions` when `paymentMethod` is set.',
    example: 'entries',
  })
  revenueSource: RevenueSource;

  @ApiProperty({
    description: 'Currency of every monetary figure.',
    example: 'ARS',
  })
  currency: string;

  @ApiProperty({
    type: RevenueBucketDto,
    description: [
      'Totals across the whole window. `key`, `from` and `to` mirror the request.',
      '',
      '**The two series use different time anchors.** Revenue lands on the bucket a stay *left* (payments carry no timestamp of their own, so exit time is the only sound axis), while `vehiclesIn` lands on the bucket it *arrived*. A car entering Monday and leaving Wednesday adds its visit to Monday and its money to Wednesday — so the dashboard toggle between $ and cars is not just a rescale of the same bars.',
    ].join('\n'),
  })
  totals: RevenueBucketDto;

  @ApiProperty({
    type: [RevenueBucketDto],
    description:
      'Chronological buckets covering the window with no gaps or overlaps. First and last are clipped to the requested instants.',
  })
  buckets: RevenueBucketDto[];
}
