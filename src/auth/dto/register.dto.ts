import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Self-registration payload. No role is accepted: every self-registered user
 * is created with the GLOBAL role `user`. Platform admins are provisioned
 * out-of-band.
 *
 * Entity association is NOT part of register. A tenant is a parking lot:
 * applicants gain an `owner` membership when their onboarding application is
 * approved; operators are linked to lots via invitations.
 */
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
}
