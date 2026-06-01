import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateRateDto {
  @ApiPropertyOptional({ example: 'NOCHE AUTO', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description: 'Precio de la hora en ARS.',
    example: 3900,
    minimum: 0,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  hourPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Precio de la estadia en ARS.',
    example: 9000,
    minimum: 0,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  stayPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Precio de la fraccion en ARS.',
    example: 325,
    minimum: 0,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  fractionPriceArs?: number;

  @ApiPropertyOptional({
    description: 'Permite activar/desactivar una tarifa.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
