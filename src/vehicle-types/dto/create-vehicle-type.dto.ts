import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { normalizeCatalogText } from '../../utils/text/normalize-catalog-text';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';

export class CreateVehicleTypeDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'Utilitario', maxLength: 60 })
  @Transform(normalizeCatalogText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  accepted?: boolean;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría de la plataforma. Los clientes nuevos la mandan siempre. ' +
      'Opcional sólo para tolerar a las cajas viejas: si falta se infiere por ' +
      'el nombre (y si no se reconoce, `other`) y el tipo queda con ' +
      '`categoryInferred = true`.',
  })
  @IsOptional()
  @IsIn(VEHICLE_CATEGORIES)
  category?: VehicleCategory;
}
