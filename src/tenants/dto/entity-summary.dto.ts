import { ApiProperty } from '@nestjs/swagger';
import type { BranchStatus, MembershipRole } from '@prisma/client';

/**
 * One entity (tenant / parking lot) the authenticated caller belongs to, with
 * the per-entity role. Powers the lot switcher in the owner/operator panels:
 * the client lists the lots the user can act on and lets them pick the active
 * one. Richer per-lot data is fetched on demand via `GET /tenants/:tenantId`.
 *
 * Every field is explicitly decorated: the `@nestjs/swagger` CLI plugin is not
 * enabled, so undecorated properties would be absent from the OpenAPI contract.
 */
export class EntitySummaryDto {
  @ApiProperty({ format: 'uuid', description: 'Entity (tenant) id.' })
  tenantId: string;

  @ApiProperty({ description: 'Display name of the entity (parking lot).' })
  name: string;

  @ApiProperty({
    enum: ['active', 'maintenance'],
    description: 'Operational status of the entity.',
  })
  status: BranchStatus;

  @ApiProperty({
    enum: ['owner', 'operator'],
    description: 'Per-entity role of the caller in this tenant.',
  })
  role: MembershipRole;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Street address of the entity, or `null` if not provided.',
  })
  address: string | null;
}
