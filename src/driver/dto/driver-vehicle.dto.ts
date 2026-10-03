import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY,
  VEHICLE_CATEGORY_API_PROPERTY,
} from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  RESERVABLE_VEHICLE_CATEGORIES,
  type ReservableVehicleCategory,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';
import { normalizePlate } from '../driver-rules';

const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizePlateValue = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizePlate(value) : value;

export class CreateDriverVehicleDto {
  @ApiProperty({
    example: 'AB123CD',
    description: 'Se normaliza (mayúsculas, sin espacios ni guiones).',
  })
  @IsString()
  @Transform(normalizePlateValue)
  @Matches(/^[A-Z0-9]{3,10}$/)
  plate: string;

  @ApiProperty({
    ...RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría de la plataforma (`GET /vehicle-categories`). Sólo se aceptan ' +
      'las reservables: una categoría que no lo es (bici, camión, otro) da 400.',
  })
  @IsIn(RESERVABLE_VEHICLE_CATEGORIES)
  category: ReservableVehicleCategory;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(60)
  brand?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(60)
  model?: string | null;

  @ApiPropertyOptional({
    description:
      'Marcarlo como principal. El primer vehículo del conductor es principal ' +
      'siempre.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateDriverVehicleDto {
  @ApiPropertyOptional({
    example: 'AB123CD',
    description:
      'Se normaliza. No se puede cambiar con una reserva activa del vehículo.',
  })
  @IsOptional()
  @IsString()
  @Transform(normalizePlateValue)
  @Matches(/^[A-Z0-9]{3,10}$/)
  plate?: string;

  @ApiPropertyOptional({
    ...RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría de la plataforma; sólo las reservables. No se puede cambiar ' +
      'con una reserva activa del vehículo.',
  })
  @IsOptional()
  @IsIn(RESERVABLE_VEHICLE_CATEGORIES)
  category?: ReservableVehicleCategory;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(60)
  brand?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(60)
  model?: string | null;

  @ApiPropertyOptional({
    description:
      'true lo marca como principal (y desmarca al anterior). Para cambiar el ' +
      'principal se marca otro: false no se acepta.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class DriverVehicleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'AB123CD' })
  plate: string;

  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría de la plataforma. La API sólo deja guardar las reservables ' +
      '(car, suv, pickup, van, motorcycle).',
  })
  category: VehicleCategory;

  @ApiProperty({ type: String, nullable: true })
  brand: string | null;

  @ApiProperty({ type: String, nullable: true })
  model: string | null;

  @ApiProperty()
  isPrimary: boolean;

  @ApiProperty({
    description:
      'Tiene una reserva activa: no se puede borrar ni cambiar patente o categoría.',
  })
  hasActiveReservation: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
