import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'Recovery token delivered in the email link (query param `token`). Issued by Supabase Auth; single-use, short TTL.',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token: string;

  @ApiProperty({
    description: 'New plaintext password.',
    minLength: 8,
    example: 'CorrectHorseBatteryStaple1!',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
