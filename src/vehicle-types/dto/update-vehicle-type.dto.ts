import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { normalizeCatalogText } from '../../utils/text/normalize-catalog-text';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';

export class UpdateVehicleTypeDto {
  @ApiPropertyOptional({ example: 'Utilitario', maxLength: 60 })
  @IsOptional()
  @Transform(normalizeCatalogText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  accepted?: boolean;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Cambia la categoría. Guardarla (aunque sea la misma) confirma la ' +
      'elección del dueño y apaga `categoryInferred`.',
  })
  @IsOptional()
  @IsIn(VEHICLE_CATEGORIES)
  category?: VehicleCategory;
}
