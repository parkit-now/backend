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
  ValidateNested,
} from 'class-validator';
import { UpdateEntityAddressDto } from '../../entities/dto/entity-address.dto';

/**
 * The single entity declared in an onboarding application. On approval it is
 * materialized as a row in `tenants` (the declared spot counts are stored in
 * the tenant settings capacity). This is the JSON shape persisted in
 * `OnboardingApplication.declaredEntity`.
 *
 * OJO: es una columna JSON sin esquema en la base, así que conviven dos
 * formas. La vieja trae sólo `address` como string plano; la nueva trae
 * `location` con los campos separados. `readDeclaredAddress()`
 * (`src/entities/tenant-address.ts`) lee las dos — si se rompe eso, los
 * borradores en vuelo pierden la dirección al aprobarse, en silencio.
 */
export class DeclaredEntityDto {
  @ApiProperty({
    description: 'Display name of the parking lot.',
    example: 'Estacionamiento del Centro',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description:
      'Dirección en una línea (campo de display, legacy). Pasó a ser OPCIONAL: el wizard nuevo manda `location` con los campos separados y su `formatted`. Si se mandan los dos, gana `location.formatted`.',
    example: 'Av. Corrientes 1234, CABA',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;

  @ApiPropertyOptional({
    type: UpdateEntityAddressDto,
    description:
      'Dirección estructurada declarada, normalizada en el front contra la API Georef. Opcional: hay borradores en vuelo que sólo traen `address`. Se materializa en columnas de `tenants` al aprobar la solicitud.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEntityAddressDto)
  location?: UpdateEntityAddressDto;

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
    description:
      'Plazas totales declaradas (van a `tenant.settings.capacity.total`).',
    example: 110,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  totalSpots?: number;
}
