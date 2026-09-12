import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsOffsetDateTime } from '../../utils/validators/is-offset-date-time';

/**
 * Filters for `GET /tenants/:tenantId/cash-sessions`.
 *
 * The endpoint used to return every shift the lot ever had, while its one
 * consumer (the web dashboard's cash-session picker) only needs the recent
 * ones. A lot running three shifts a day piles up about a thousand a year.
 *
 * `from`/`to` match by **overlap**, not containment: a shift that opened before
 * `from` but was still running at `from` belongs to that window — it is the
 * shift the owner was looking at.
 */
export class ListCashSessionsQueryDto {
  @ApiPropertyOptional({
    description:
      'Only shifts still running after this instant (they overlap the window). ISO-8601 with explicit offset.',
    example: '2026-09-01T00:00:00-03:00',
  })
  @IsOptional()
  @IsOffsetDateTime()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Only shifts opened before this instant (exclusive). ISO-8601 with explicit offset.',
    example: '2026-09-08T00:00:00-03:00',
  })
  @IsOptional()
  @IsOffsetDateTime()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Max shifts to return, most recent first. The endpoint used to return every shift ever; it now caps at this many.',
    default: 100,
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;
}
