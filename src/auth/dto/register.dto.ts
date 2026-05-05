import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The roles a user can self-assign on registration.
 * `admin` is platform-level and is provisioned out-of-band — never via this
 * endpoint.
 *
 * Tenant association is NOT part of register. A tenant is a parking lot:
 * owners create lots in a separate flow (one or many); operators are linked
 * to lots via invitations; drivers and admins never have a tenant.
 */
export const RegistrableRoles = [
  UserRole.owner,
  UserRole.operator,
  UserRole.driver,
] as const;

export class RegisterDto {
  @ApiProperty({
    description: 'Email address used for login. Must be unique platform-wide.',
    format: 'email',
    example: 'jane.doe@parkit.com',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    description:
      'Password. Minimum 8 characters; the Supabase project may enforce stricter rules.',
    minLength: 8,
    example: 'CorrectHorseBatteryStaple1!',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @ApiProperty({
    description:
      'Role to assign to the new user. `admin` is rejected — platform admins are provisioned manually.',
    enum: RegistrableRoles,
    example: UserRole.driver,
  })
  @IsIn(RegistrableRoles)
  role: Exclude<UserRole, typeof UserRole.admin>;
}
