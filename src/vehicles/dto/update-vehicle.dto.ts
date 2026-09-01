import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { normalizeVehicleText } from './create-vehicle.dto';

export class UpdateVehicleDto {
  @ApiPropertyOptional({ example: 'Toyota', maxLength: 120 })
  @IsOptional()
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ example: 'Corolla', maxLength: 120 })
  @IsOptional()
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo de vehículo, de la tabla de tipos de este estacionamiento.',
  })
  @IsOptional()
  @IsUUID()
  typeId?: string;
}
