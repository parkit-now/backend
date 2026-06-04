import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

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
    description:
      'Entry timestamp (ISO 8601). Defaults to now if omitted by the server.',
    format: 'date-time',
  })
  @IsDateString()
  enteredAt: string;

  @ApiProperty({ description: 'ID of the vehicle.', format: 'uuid' })
  @IsUUID()
  vehicleId: string;

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

  @ApiPropertyOptional({
    description: 'Snapshot: hour price in ARS.',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotHourPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Snapshot: stay price in ARS.',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotStayPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Snapshot: fraction price in ARS.',
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateSnapshotFractionPriceArs?: number;
}
