import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { VehicleTypeDto } from './vehicle-type.dto';

export class VehicleTypeChangesResponseDto {
  @ApiProperty({ type: [VehicleTypeDto] })
  items: VehicleTypeDto[];

  @ApiProperty({ type: Number })
  maxSeq: number;
}

export class VehicleTypeChangesQueryDto {
  @ApiPropertyOptional({
    description: 'Devuelve las filas con syncSeq mayor a este valor.',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq = 0;

  @ApiPropertyOptional({
    description: 'Máximo de items por página.',
    default: 1000,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 1000;
}
