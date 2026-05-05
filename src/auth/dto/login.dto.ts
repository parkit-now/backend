import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Email used at registration time.',
    format: 'email',
    example: 'jane.doe@parkit.com',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    description: 'Plaintext password.',
    minLength: 1,
    example: 'CorrectHorseBatteryStaple1!',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;
}
