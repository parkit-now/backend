import { ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleBodyType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
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

  @ApiPropertyOptional({ enum: VehicleBodyType, example: VehicleBodyType.auto })
  @IsOptional()
  @IsEnum(VehicleBodyType)
  type?: VehicleBodyType;
}
