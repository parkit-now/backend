import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

/**
 * The single entity declared in an onboarding application. On approval it is
 * materialized as a row in `tenants` (the declared spot counts are stored in
 * the tenant settings capacity). This is the JSON shape persisted in
 * `OnboardingApplication.declaredEntity`.
 */
export class DeclaredEntityDto {
  @ApiProperty({
    description: 'Display name of the parking lot.',
    example: 'Estacionamiento del Centro',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Address of the parking lot.',
    example: 'Av. Corrientes 1234, CABA',
  })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({
    description: 'Registered legal name of the entity.',
    example: 'Estacionamientos del Centro S.A.',
  })
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiProperty({ example: '30123456789', description: 'CUIT, 11 digits' })
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit: string;

  @ApiProperty({
    format: 'email',
    description: 'Contact email of the entity.',
    example: 'contacto@estacionamiento.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Contact phone of the entity.',
    example: '+541145678900',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Declared car spots (stored in the tenant settings capacity).',
    example: 80,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  carSpots?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description:
      'Declared motorcycle spots (stored in the tenant settings capacity).',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  motorcycleSpots?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description:
      'Declared bicycle spots (stored in the tenant settings capacity).',
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bicycleSpots?: number;
}
