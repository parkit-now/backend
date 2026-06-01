import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

/** Company profile edit. The CUIT is immutable (legal identity). */
export class UpdateCompanyProfileDto {
  @ApiPropertyOptional({
    description: 'New legal name of the company.',
    example: 'Parkit Holdings S.A.',
  })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiPropertyOptional({
    format: 'email',
    description: 'New contact email of the company.',
    example: 'contact@parkit.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'New contact phone number of the company.',
    example: '+54 11 5555-1234',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description: 'New address of the company.',
    example: 'Av. Corrientes 1000, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;
}
