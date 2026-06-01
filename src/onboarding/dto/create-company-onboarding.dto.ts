import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Onboarding step 1: the owner creates their company with the legal data.
 * Creates Company(status=pending) + OnboardingApplication(status=draft).
 */
export class CreateCompanyOnboardingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiProperty({ example: '30123456789', description: 'CUIT, 11 digits' })
  @IsString()
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  address: string;
}
