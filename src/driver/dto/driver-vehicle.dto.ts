import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { normalizePlate } from '../driver-rules';

/** Categoría del vehículo del conductor. */
export enum DriverVehicleKind {
  car = 'car',
  suvPickup = 'suv_pickup',
  motorcycle = 'motorcycle',
}

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

  @ApiProperty({ enum: DriverVehicleKind, enumName: 'DriverVehicleKind' })
  @IsEnum(DriverVehicleKind)
  kind: DriverVehicleKind;

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
    enum: DriverVehicleKind,
    enumName: 'DriverVehicleKind',
    description: 'No se puede cambiar con una reserva activa del vehículo.',
  })
  @IsOptional()
  @IsEnum(DriverVehicleKind)
  kind?: DriverVehicleKind;

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

  @ApiProperty({ enum: DriverVehicleKind, enumName: 'DriverVehicleKind' })
  kind: DriverVehicleKind;

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
