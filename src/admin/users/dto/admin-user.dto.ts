import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

/**
 * Public representation of a platform user for the admin panel.
 *
 * `name` mirrors the Supabase Auth metadata (nullable for email/password
 * sign-ups). The global `role` is `admin | user`; per-parking roles live on the
 * memberships (see `AdminUserDetailDto`).
 */
export class AdminUserDto {
  @ApiProperty({ format: 'uuid', description: 'User id (uuid, from Auth).' })
  id: string;

  @ApiProperty({ description: 'Login email (unique).' })
  email: string;

  @ApiProperty({
    nullable: true,
    description: 'Display name mirrored from Supabase Auth, if any.',
  })
  name: string | null;

  @ApiProperty({
    enum: UserRole,
    description: 'Global platform role: `admin` or `user`.',
  })
  role: UserRole;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'Provisioning timestamp.',
  })
  createdAt: Date;
}
