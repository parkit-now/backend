import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole, UserRole } from '@prisma/client';

/**
 * One entity (tenant) the authenticated user belongs to, with the per-entity
 * role. This is how clients learn which lots a `user` can act on and whether
 * they are `owner` or `operator` there — the entity role is NOT in the JWT.
 */
export class MeMembershipDto {
  @ApiProperty({ format: 'uuid', description: 'Entity (tenant) id.' })
  tenantId: string;

  @ApiProperty({ description: 'Entity (tenant) display name.' })
  tenantName: string;

  @ApiProperty({
    nullable: true,
    description:
      'Entity (tenant) street address as one display line, or `null` if the ' +
      'entity never declared one. The desktop prints it on the entry ticket.',
  })
  tenantAddress: string | null;

  @ApiProperty({
    enum: MembershipRole,
    description: 'Per-entity role of the caller in this tenant.',
  })
  role: MembershipRole;
}

/**
 * Response of `GET /auth/me`: the caller's identity plus the entities they can
 * act on. Admins have an empty `memberships` array (they bypass membership).
 */
export class MeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email' })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Full name of the user, or `null` for accounts created before the name was required (or social logins without a name).',
    example: 'Jane Doe',
  })
  name: string | null;

  @ApiProperty({
    enum: UserRole,
    description: 'GLOBAL platform role (`admin | user`).',
  })
  role: UserRole;

  @ApiProperty({
    type: MeMembershipDto,
    isArray: true,
    description: 'Entities the caller belongs to, with their per-entity role.',
  })
  memberships: MeMembershipDto[];
}
