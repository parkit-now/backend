import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

/**
 * Public projection of a `User`. Does NOT include any auth.* columns
 * (Supabase Auth owns those). Use `UsersService.toResponse(user)` to map
 * a Prisma row into this shape.
 */
export class UserResponseDto {
  @ApiProperty({
    description:
      'UUID of the user. Equal to `auth.users.id` in Supabase Auth — treat it as opaque.',
    example: '6b2a3a4d-31d0-4f9b-9b1e-a31f5b6d6a55',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    description:
      'Email address. Mirrored from `auth.users.email` at provisioning time. Unique within Supabase Auth.',
    format: 'email',
    example: 'jane.doe@parkit.com',
  })
  email: string;

  @ApiProperty({
    description:
      'Authorization role of the user. Drives access in `RolesGuard`. Tenant associations live in `user_memberships` and are not part of this projection.',
    enum: UserRole,
    enumName: 'UserRole',
    example: UserRole.operator,
  })
  role: UserRole;
}
