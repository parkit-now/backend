import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsTimeZone } from 'class-validator';
import { DEFAULT_TIME_ZONE } from '../metrics-tz';

/**
 * Base query for every metrics endpoint that buckets by civil day.
 *
 * The API stores instants in UTC and `tenants` carries no timezone, so the
 * caller decides which civil day "today" means. Concrete queries extend this;
 * Swagger picks up the inherited decorator because the `@nestjs/swagger` CLI
 * plugin is intentionally off in this repo — every property needs its own
 * `@ApiPropertyOptional`.
 */
export class MetricsTzQueryDto {
  @ApiPropertyOptional({
    type: String,
    default: DEFAULT_TIME_ZONE,
    description:
      'IANA timezone used to delimit civil days (e.g. `America/Argentina/Buenos_Aires`). Defaults to Argentina.',
    example: DEFAULT_TIME_ZONE,
  })
  @IsOptional()
  @IsTimeZone()
  tz?: string = DEFAULT_TIME_ZONE;
}
