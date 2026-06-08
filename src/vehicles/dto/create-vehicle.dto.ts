import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { VehicleType } from '@prisma/client';

export class CreateVehicleDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'Toyota', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  brand: string;

  @ApiProperty({ example: 'Corolla', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  model: string;

  @ApiPropertyOptional({ enum: VehicleType, example: 'auto' })
  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;
}
