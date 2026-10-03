import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';

export class LprEntryDto {
  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  plate: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Snapshot del nombre del tipo al momento del ingreso. Si coincide con ' +
      'un tipo vivo del estacionamiento (sin distinguir mayúsculas) se ' +
      'resuelven también `vehicleTypeId` y la categoría; si no, la categoría ' +
      'se intenta adivinar por el nombre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  vehicleType?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo del estacionamiento. Si resuelve, manda sobre `vehicleType` y ' +
      '`vehicleCategory`.',
  })
  @IsOptional()
  @IsUUID()
  vehicleTypeId?: string;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría del vehículo, si el tipo no resuelve a uno del estacionamiento.',
  })
  @IsOptional()
  @IsIn(VEHICLE_CATEGORIES)
  vehicleCategory?: VehicleCategory;

  @ApiPropertyOptional({
    description: 'URL of the entry photo captured by the LPR camera',
  })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cameraId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Detection timestamp (ISO 8601). Defaults to server time if omitted.',
  })
  @IsOptional()
  @IsDateString()
  timestamp?: string;
}
