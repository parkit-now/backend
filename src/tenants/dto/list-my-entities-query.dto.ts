import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { MembershipRole } from '@prisma/client';

/** Optional filter for `GET /tenants`: restrict to a per-entity role. */
export class ListMyEntitiesQueryDto {
  @ApiPropertyOptional({
    enum: ['owner', 'operator'],
    description:
      'Return only entities where the caller holds this per-entity role. Returns all memberships when omitted.',
    example: 'owner',
  })
  @IsOptional()
  @IsIn(['owner', 'operator'])
  role?: MembershipRole;
}
