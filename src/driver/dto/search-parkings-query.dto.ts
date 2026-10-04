import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_RESULTS = 20;

export class SearchParkingsQueryDto {
  @ApiProperty({
    example: 'once',
    minLength: SEARCH_MIN_LENGTH,
    maxLength: 80,
    description:
      'Texto a buscar en el nombre o la dirección (sin distinguir mayúsculas). Mínimo 2 caracteres, sin contar los espacios de los extremos.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(SEARCH_MIN_LENGTH)
  @MaxLength(80)
  q: string;

  @ApiPropertyOptional({
    example: -34.6037,
    description:
      'Latitud del conductor. Se usa solo si se envía junto con `longitude`, cada resultado trae la distancia y se ordena por ella; si no, se ordena por nombre.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({
    example: -58.3816,
    description: 'Longitud del conductor (va junto con `latitude`).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}
