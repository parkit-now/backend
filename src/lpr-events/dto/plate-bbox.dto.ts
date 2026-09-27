import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * Dónde está la patente dentro de la imagen del evento.
 *
 * En FRACCIONES de la imagen (0 a 1), no en píxeles: la foto se reescala y se
 * comprime antes de subirse, así que un bbox en píxeles del frame original no
 * correspondería a la imagen que está en el bucket. En fracciones, el recorte
 * es un porcentaje de CSS y sobrevive a cualquier reescalado.
 */
export class PlateBboxDto {
  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  /** Mayor que cero: un recorte de área nula divide por cero en el CSS. */
  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(Number.MIN_VALUE)
  @Max(1)
  w: number;

  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(Number.MIN_VALUE)
  @Max(1)
  h: number;
}
