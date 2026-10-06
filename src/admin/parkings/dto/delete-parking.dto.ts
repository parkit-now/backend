import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

/** Días de gracia por defecto antes de que la purga pueda borrar de verdad. */
export const DEFAULT_GRACE_DAYS = 30;
export const MAX_GRACE_DAYS = 365;

export class DeleteParkingDto {
  @ApiProperty({
    description:
      'El nombre del estacionamiento, tipeado por el admin. Se compara ' +
      'normalizado (NFC, sin distinguir mayúsculas ni espacios del borde). ' +
      'Un botón solo no alcanza para un borrado.',
    example: 'Playa Centro',
  })
  @IsString()
  @MaxLength(255)
  confirmName: string;

  @ApiPropertyOptional({
    description:
      'Días hasta que la purga pueda borrarlo definitivamente. `0` lo deja ' +
      'listo para la próxima corrida del job, que es lo que se usa para ' +
      'limpiar datos de prueba. Por defecto 30.',
    minimum: 0,
    maximum: MAX_GRACE_DAYS,
    default: DEFAULT_GRACE_DAYS,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_GRACE_DAYS)
  graceDays?: number;

  @ApiPropertyOptional({
    description: 'Motivo, para la auditoría.',
    example: 'Datos de prueba previos al arranque productivo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
