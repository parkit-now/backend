import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
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
    maxLength: 60,
    description: [
      'Restrict to a vehicle type, matched **exactly** against `entries.vehicleType`.',
      '',
      'Free text rather than a closed enum: vehicle types are a per-tenant catalogue (`GET /tenants/:tenantId/vehicle-types`), which is where the client should populate this filter from. `entries.vehicleType` stores a *snapshot* of the type name taken at ingress, so renaming a type does not rewrite history — stays registered under the old name keep answering to the old name.',
      '',
      '**Partial data:** `entries.vehicleType` is only populated on LPR ingress (`source = "auto"`); manually registered stays leave it null and are excluded by this filter.',
    ].join('\n'),
    example: 'Auto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  vehicleType?: string;
}
