import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsOffsetDateTime } from '../../utils/validators/is-offset-date-time';
import type { Granularity } from '../metrics-tz';
import { MetricsTzQueryDto } from './metrics-tz-query.dto';

const GRANULARITIES: Granularity[] = ['hour', 'day', 'week', 'month'];

/**
 * Window + filters for the owner revenue dashboard.
 *
 * `from`/`to` describe a **continuous interval**, not a daily recurring
 * window: `2026-08-07T13:00-03:00` → `2026-08-18T03:00-03:00` is one stretch
 * covering every night in between, with the edge buckets clipped.
 */
export class RevenueQueryDto extends MetricsTzQueryDto {
  @ApiProperty({
    description: [
      'Start of the window (inclusive), ISO-8601 **with an explicit offset**.',
      '',
      'The offset is mandatory: a naive `2026-08-07T13:00:00` would be resolved against the server clock, silently shifting the numbers by the Argentine offset. Send `-03:00` for Argentine wall-clock time.',
    ].join('\n'),
    example: '2026-08-07T13:00:00-03:00',
  })
  @IsOffsetDateTime()
  from: string;

  @ApiProperty({
    description:
      'End of the window (exclusive), ISO-8601 with explicit offset.',
    example: '2026-08-18T03:00:00-03:00',
  })
  @IsOffsetDateTime()
  to: string;

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

  @ApiPropertyOptional({
    enum: VehicleType,
    description: [
      'Restrict to a vehicle type. **Partial data:** `entries.vehicleType` is only populated on LPR ingress (`source = "auto"`); manually registered stays leave it null and are excluded by this filter.',
    ].join('\n'),
    example: 'auto',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;
}
