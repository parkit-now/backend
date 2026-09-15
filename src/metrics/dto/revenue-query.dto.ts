import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Granularity } from '../metrics-tz';
import { MetricsWindowQueryDto } from './metrics-window-query.dto';

const GRANULARITIES: Granularity[] = ['hour', 'day', 'week', 'month'];

/** Window + filters for the revenue time series. */
export class RevenueQueryDto extends MetricsWindowQueryDto {
  @ApiPropertyOptional({
    enum: GRANULARITIES,
    default: 'day',
    description:
      'Bucket width. Buckets follow the civil calendar of `tz`, so a DST day stays one bucket.',
    example: 'day',
  })
  @IsOptional()
  @IsIn(GRANULARITIES)
  granularity?: Granularity = 'day';

  @ApiPropertyOptional({
    description: [
      'Restrict to stays paid with this payment method (the snapshot name stored on the transaction, e.g. `Efectivo`).',
      '',
      'Setting it switches `revenue` to sum `payment_transactions` instead of `entries.amountPaid` — the transactions table is the only place the per-method split exists. The response reports this in `revenueSource`.',
    ].join('\n'),
    example: 'Efectivo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentMethod?: string;
}
