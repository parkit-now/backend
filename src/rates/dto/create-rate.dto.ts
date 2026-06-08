import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRateDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
    example: '018f44f7-9a96-7f75-9e9c-44ed9432fc12',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'DIA AUTO', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description: 'Precio de la hora en ARS.',
    example: 3600,
    minimum: 0,
    type: Number,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  hourPriceArs: number;

  @ApiProperty({
    description: 'Precio de la estadia en ARS.',
    example: 8000,
    minimum: 0,
    type: Number,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  stayPriceArs: number;

  @ApiProperty({
    description: 'Precio de la fraccion en ARS.',
    example: 300,
    minimum: 0,
    type: Number,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  fractionPriceArs: number;

  @ApiPropertyOptional({
    description: 'Número de atajo para selección rápida en la operación.',
    example: 1,
    minimum: 1,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  shortcutNumber?: number;
}
