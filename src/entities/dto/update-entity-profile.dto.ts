import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

/** Editable fields of an entity (tenant) profile. */
export class UpdateEntityProfileDto {
  @ApiPropertyOptional({
    description: 'New display name of the entity.',
    example: 'Estacionamiento del Centro',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'New legal name of the entity.',
    example: 'Estacionamientos del Centro S.A.',
  })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiPropertyOptional({
    description: 'New CUIT (Argentine tax id), 11 digits.',
    example: '30123456789',
  })
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit?: string;

  @ApiPropertyOptional({
    format: 'email',
    description: 'New contact email of the entity.',
    example: 'contact@parkit.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'New contact phone number of the entity.',
    example: '+54 11 5555-1234',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description: 'New address of the entity.',
    example: 'Av. Corrientes 1000, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;
}
