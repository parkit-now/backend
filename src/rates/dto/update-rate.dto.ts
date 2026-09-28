import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
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
    description:
      'Tope de las primeras 12 horas en ARS. 0 = la tarifa no tiene este escalón.',
    example: 12000,
    minimum: 0,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  mediaEstadiaPriceArs?: number;

  @ApiPropertyOptional({
    description:
      'Si la fracción se deriva de hora / 12 en el formulario. Preferencia de UI: el valor derivado se guarda igual en fractionPriceArs.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  autoFractionPrice?: boolean;

  @ApiPropertyOptional({
    description: 'Permite activar/desactivar una tarifa.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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

  @ApiPropertyOptional({
    description:
      'Si los autos que están adentro con esta tarifa pasan a los precios ' +
      'nuevos. Ausente o false = se quedan con el precio que tenían al ' +
      'entrar, que es el comportamiento histórico. Sólo aplica si el body ' +
      'trae algún precio: mandarlo con un cambio de nombre no hace nada.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  applyToOpenEntries?: boolean;
}
