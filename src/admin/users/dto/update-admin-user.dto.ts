import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * Admin payload to change a user's GLOBAL role (`admin | user`). Email and name
 * are owned by Supabase Auth and are not editable here; per-parking roles are
 * managed through the membership endpoints.
 */
export class UpdateAdminUserDto {
  @ApiProperty({
    enum: UserRole,
    description: 'New global platform role.',
  })
  @IsEnum(UserRole)
  role: UserRole;
}
