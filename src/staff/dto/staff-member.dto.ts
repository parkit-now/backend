import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole, UserRole } from '@prisma/client';

/** One person's role at one of the caller's lots. */
export class StaffMembershipDto {
  @ApiProperty({ format: 'uuid', description: 'Lot (tenant) identifier.' })
  tenantId: string;

  @ApiProperty({
    description: 'Lot display name, so the table needs no second lookup.',
    example: 'Estacionamiento Once',
  })
  tenantName: string;

  @ApiProperty({
    enum: MembershipRole,
    description: 'Role held at this lot.',
    example: 'operator',
  })
  role: MembershipRole;

  @ApiProperty({
    format: 'date-time',
    description: 'When the person was linked to this lot.',
  })
  createdAt: Date;
}

/**
 * One row of the staff table: a person, with every role they hold across the
 * lots the caller owns.
 *
 * Grouped by person rather than by membership so someone working at two
 * branches occupies one row with two roles, which is what the dashboard shows.
 */
export class StaffMemberDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Display name mirrored from Supabase Auth. `null` for accounts created by email/password without one.',
    example: 'Ana Gómez',
  })
  name: string | null;

  @ApiProperty({ format: 'email', example: 'ana@example.com' })
  email: string;

  @ApiProperty({
    enum: UserRole,
    description:
      'Platform-level role (`admin` | `user`). Not the role at a lot — that lives in `memberships`.',
    example: 'user',
  })
  globalRole: UserRole;

  @ApiProperty({
    type: [StaffMembershipDto],
    description:
      'Roles held across the caller’s lots only, oldest link first. Lots the caller does not own are never revealed, even when the person works there.',
  })
  memberships: StaffMembershipDto[];

  @ApiProperty({ format: 'date-time', description: 'Account creation date.' })
  createdAt: Date;
}
