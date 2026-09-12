import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class LprEntryDto {
  @ApiProperty({ example: 'ABC123', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  plate: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'Snapshot del nombre del tipo al momento del ingreso.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  vehicleType?: string;

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
