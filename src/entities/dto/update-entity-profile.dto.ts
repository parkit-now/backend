import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import type { BranchStatus } from '@prisma/client';
import { UpdateEntityAddressDto } from './entity-address.dto';

/**
 * Allowed values for `lprImageRetentionDays`. A closed set instead of a free
 * 30-365 range on purpose: privacy-by-design calls for a short, defensible
 * default plus a handful of vetted options, not a knob any owner can push to
 * the ceiling with no documented reason. A per-event legal-hold exception
 * (for a specific plate under dispute) is a separate, not-yet-built
 * mechanism — it should never be "raise the whole tenant's window".
 */
export const LPR_IMAGE_RETENTION_DAYS_OPTIONS = [30, 60, 90] as const;

/** Editable per-vehicle-type spot capacity of the lot (stored in settings). */
export class UpdateEntityCapacityDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Plazas totales del estacionamiento.',
    example: 110,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  total?: number;
}

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
    description:
      'Nueva dirección en una línea (campo de display, legacy). Si también se manda `location.formatted`, gana ese.',
    example: 'Av. Corrientes 1000, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    type: UpdateEntityAddressDto,
    description:
      'Dirección estructurada. Sólo se actualizan los campos presentes; mandar `null` explícito borra ese campo. Las coordenadas van completas (lat + lng) o ninguna: la base rechaza media coordenada.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEntityAddressDto)
  location?: UpdateEntityAddressDto;

  @ApiPropertyOptional({
    enum: ['active', 'maintenance'],
    description:
      'New operational status. Use `maintenance` to take the lot offline.',
    example: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'maintenance'])
  status?: BranchStatus;

  @ApiPropertyOptional({
    type: UpdateEntityCapacityDto,
    description:
      'New per-vehicle-type spot capacity. Only the provided types are updated; the rest keep their current value.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEntityCapacityDto)
  capacity?: UpdateEntityCapacityDto;

  @ApiPropertyOptional({
    type: 'integer',
    enum: LPR_IMAGE_RETENTION_DAYS_OPTIONS,
    description:
      'How long (in days) a `registered` LPR detection image is kept after the stay exit before the retention job purges it. One of 30/60/90. Owner-only.',
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(LPR_IMAGE_RETENTION_DAYS_OPTIONS)
  lprImageRetentionDays?: number;
}
