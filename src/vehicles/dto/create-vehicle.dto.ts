import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

  @ApiPropertyOptional({ example: 'sedan', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ example: 'ABC123', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;
}
