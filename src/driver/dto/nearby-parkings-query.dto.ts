import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export const DEFAULT_RADIUS_METERS = 5000;

export class NearbyParkingsQueryDto {
  @ApiProperty({ example: -34.6037, description: 'Latitud del centro.' })
  @Type(() => Number)
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: -58.3816, description: 'Longitud del centro.' })
  @Type(() => Number)
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({
    example: DEFAULT_RADIUS_METERS,
    minimum: 100,
    maximum: 20000,
    description: 'Radio de búsqueda en metros.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(20000)
  radiusMeters?: number;
}
