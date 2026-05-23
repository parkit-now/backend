import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Email of the account requesting a password reset.',
    format: 'email',
    example: 'jane.doe@parkit.com',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;
}
