import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { BranchStatus } from '@prisma/client';

/** Editable per-vehicle-type spot capacity of the lot (stored in settings). */
export class UpdateEntityCapacityDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Number of car spots.',
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
    description: 'Number of motorcycle spots.',
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
    description: 'Number of bicycle spots.',
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bicycleSpots?: number;
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
    description: 'New address of the entity.',
    example: 'Av. Corrientes 1000, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;

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
    minimum: 30,
    maximum: 365,
    description:
      'How long (in days) a `registered` LPR detection image is kept after the stay exit before the retention job purges it. Must be between 30 and 365. Owner-only.',
    example: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(365)
  lprImageRetentionDays?: number;
}
