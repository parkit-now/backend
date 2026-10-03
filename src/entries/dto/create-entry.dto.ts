import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';

export class CreateEntryDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
    example: '018f44f7-9a96-7f75-9e9c-44ed9432fc12',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  plate: string;

  @ApiPropertyOptional({ example: 'Rojo', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @ApiPropertyOptional({ example: 'Cochera 3', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cochera?: string;

  @ApiPropertyOptional({ example: 'Cliente frecuente', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({
    description: 'Entry timestamp (ISO 8601).',
    format: 'date-time',
  })
  @IsDateString()
  enteredAt: string;

  @ApiPropertyOptional({ example: 'Volkswagen', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleBrand?: string;

  @ApiPropertyOptional({ example: 'Bora', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleModel?: string;

  @ApiPropertyOptional({
    description:
      'Tipo de vehículo elegido (`GET /tenants/:tenantId/vehicle-types`). ' +
      'Opcional: las cajas viejas no lo mandan y el ingreso queda sin tipo. Si ' +
      'es de otro estacionamiento o no existe se ignora, sin error. De ahí ' +
      'salen el nombre (`vehicleType`) y la categoría que se guardan.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  vehicleTypeId?: string;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description:
      'Categoría del vehículo. Sólo se usa si `vehicleTypeId` no resuelve a un ' +
      'tipo del estacionamiento; si resuelve, manda la categoría del tipo.',
  })
  @IsOptional()
  @IsIn(VEHICLE_CATEGORIES)
  vehicleCategory?: VehicleCategory;

  @ApiPropertyOptional({
    description:
      'Reserva que mostró el banner de la caja (`GET /reservations/match`). ' +
      'Opcional: sin ella el backend busca igual por patente (ingresos sin ' +
      'conexión, LPR). Si ya no es válida (otra patente, fuera de la ventana, ' +
      'ya usada) se ignora y se busca por patente: el ingreso NUNCA se rechaza ' +
      'por esto.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  reservationId?: string;

  @ApiPropertyOptional({
    description: 'ID of the selected rate.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  rateId?: string;

  @ApiPropertyOptional({ example: 'Tarifa Día Auto', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  rateSnapshotName?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotHourPriceArs?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotStayPriceArs?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotFractionPriceArs?: number;

  /** Ausente = la tarifa vigente al ingresar no tenía escalón de media estadía. */
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotMediaEstadiaPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Cash session this entry belongs to.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  cashSessionId?: string;

  @ApiPropertyOptional({
    description: 'Sequential ticket number within the cash session.',
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ticketNumber?: number;
}
