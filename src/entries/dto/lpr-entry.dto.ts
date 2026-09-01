import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleBodyType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class LprEntryDto {
  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  plate: string;

  @ApiPropertyOptional({ enum: VehicleBodyType })
  @IsOptional()
  @IsEnum(VehicleBodyType)
  vehicleType?: VehicleBodyType;

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
