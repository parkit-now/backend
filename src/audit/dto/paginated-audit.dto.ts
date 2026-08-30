import { ApiProperty } from '@nestjs/swagger';
import { AuditEventDto } from './audit-event.dto';

/**
 * Response of `GET /tenants/:tenantId/audit`.
 *
 * **Breaking change:** this endpoint previously returned a bare
 * `AuditEventDto[]` capped by `limit`. It now pages, so clients read `items`
 * and drive the table from `total`.
 */
export class PaginatedAuditDto {
  @ApiProperty({
    type: [AuditEventDto],
    description: 'Events on this page, most recent first.',
  })
  items: AuditEventDto[];

  @ApiProperty({
    type: 'integer',
    description: '1-based page number.',
    example: 1,
  })
  page: number;

  @ApiProperty({ type: 'integer', description: 'Items per page.', example: 20 })
  pageSize: number;

  @ApiProperty({
    type: 'integer',
    description: 'Total events matching the filters, across every page.',
    example: 137,
  })
  total: number;
}
