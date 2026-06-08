import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class UpdateVehicleDto {
  @ApiPropertyOptional({ example: 'Toyota', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ example: 'Corolla', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ enum: VehicleType, example: 'auto' })
  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;
}
