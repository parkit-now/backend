import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { IsOffsetDateTime } from '../../utils/validators/is-offset-date-time';
import { MetricsTzQueryDto } from './metrics-tz-query.dto';

/**
 * The time window every analytical metrics endpoint takes, plus the filters
 * they all share.
 *
 * `from`/`to` describe a **continuous interval**, not a daily recurring
 * window: `2026-08-07T13:00-03:00` → `2026-08-18T03:00-03:00` is one stretch
 * covering every night in between.
 *
 * `tz` is inherited so clients can send the same query object everywhere —
 * the global pipe runs with `forbidNonWhitelisted`, so an undeclared parameter
 * is a 400. It only changes behaviour where results are bucketed by calendar.
 */
export class MetricsWindowQueryDto extends MetricsTzQueryDto {
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
    enum: VehicleType,
    description:
      'Restrict to a vehicle type. **Partial data:** `entries.vehicleType` is only populated on LPR ingress (`source = "auto"`); manually registered stays leave it null and are excluded by this filter.',
    example: 'auto',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;
}
