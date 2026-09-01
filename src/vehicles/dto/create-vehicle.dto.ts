import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleBodyType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { normalizeCatalogText } from '../../utils/text/normalize-catalog-text';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Alias histórico de `normalizeCatalogText`. Se mantiene el nombre porque lo
 * importan `update-vehicle.dto.ts` y los tests.
 */
export const normalizeVehicleText = normalizeCatalogText;

export class CreateVehicleDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'Toyota', maxLength: 120 })
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  brand: string;

  @ApiProperty({ example: 'Corolla', maxLength: 120 })
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  model: string;

  @ApiPropertyOptional({ enum: VehicleBodyType, example: VehicleBodyType.auto })
  @IsOptional()
  @IsEnum(VehicleBodyType)
  type?: VehicleBodyType;
}
