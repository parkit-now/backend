import { ApiPropertyOptional } from '@nestjs/swagger';
import type { AuditSeverity } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';
import { AuditActions } from '../../audit/audit.service';
import { IsOffsetDateTime } from '../../utils/validators/is-offset-date-time';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';

/** Every action the catalog can emit, for validation and Swagger. */
const AUDIT_ACTIONS = Object.values(AuditActions);

/**
 * Filters for the entity audit trail.
 *
 * Pagination replaces the previous `limit`: the dashboard renders this as a
 * table and needs a total to page through.
 */
export class EntityAuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['info', 'warn', 'crit'],
    description:
      'Filter events by severity. Returns all severities when omitted.',
    example: 'warn',
  })
  @IsOptional()
  @IsIn(['info', 'warn', 'crit'])
  severity?: AuditSeverity;

  @ApiPropertyOptional({
    enum: AUDIT_ACTIONS,
    description:
      'Filter by a single action from the catalog (`<entity>.<verb>`). Validated against the catalog, so a typo fails loudly instead of silently returning nothing.',
    example: 'entity.profile_updated',
  })
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: string;

  @ApiPropertyOptional({
    description:
      'Only events at or after this instant. ISO-8601 **with an explicit offset** (e.g. `-03:00`), matching the metrics endpoints.',
    example: '2026-08-01T00:00:00-03:00',
  })
  @IsOptional()
  @IsOffsetDateTime()
  from?: string;

  @ApiPropertyOptional({
    description:
      'Only events strictly before this instant, same format as `from`.',
    example: '2026-09-01T00:00:00-03:00',
  })
  @IsOptional()
  @IsOffsetDateTime()
  to?: string;
}
