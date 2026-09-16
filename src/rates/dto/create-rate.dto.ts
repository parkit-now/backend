import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

  @ApiProperty({
    description:
      'Tope de las primeras 12 horas en ARS. 0 = la tarifa no tiene este escalón.',
    example: 12000,
    minimum: 0,
    type: Number,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  mediaEstadiaPriceArs: number;

  @ApiPropertyOptional({
    description:
      'Si la fracción se deriva de hora / 12 en el formulario. Preferencia de UI: el valor derivado se guarda igual en fractionPriceArs.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  autoFractionPrice?: boolean;

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
