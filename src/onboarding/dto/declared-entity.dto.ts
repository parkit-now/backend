import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { UpdateEntityAddressDto } from '../../entities/dto/entity-address.dto';
import { CreateScheduleDto } from '../../schedules/dto/create-schedule.dto';

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

  @ApiPropertyOptional({
    description:
      'Registered legal name of the entity. OPCIONAL: ya no se pide en el alta, se completa después desde la configuración del perfil. Ausente → el tenant queda con `legalName` en null.',
    example: 'Estacionamientos del Centro S.A.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  legalName?: string;

  @ApiPropertyOptional({
    example: '30123456789',
    description:
      'CUIT, 11 digits. OPCIONAL: ya no se pide en el alta. Si viene, tiene que tener 11 dígitos.',
  })
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit?: string;

  @ApiProperty({
    format: 'email',
    description: 'Contact email of the entity.',
    example: 'contacto@estacionamiento.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description:
      'Contact phone of the person in charge, in international E.164 format (with the leading `+` and country code, no spaces).',
    example: '+5491123456789',
  })
  @IsPhoneNumber(undefined, {
    message: 'phone must be a valid phone number in E.164 format (+549...)',
  })
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

  @ApiPropertyOptional({
    type: [CreateScheduleDto],
    maxItems: 28,
    description:
      'Horarios de atención declarados: una fila por franja (un día puede tener varias). Se crean como `schedules` del tenant al aprobar. Se validan con la misma regla que `/schedules` (open < close, sin solapes en el mismo día; franjas contiguas OK) y, si no cumplen, se responde 422 `ONBOARDING_NOT_SUBMITTABLE` con `validationsErrors` en `declaredEntity.schedules.<i>`. Un PATCH con `schedules` REEMPLAZA la lista entera.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => CreateScheduleDto)
  schedules?: CreateScheduleDto[];
}
