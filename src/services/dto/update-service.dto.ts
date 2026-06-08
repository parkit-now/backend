import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateServiceDto {
  @ApiPropertyOptional({
    description: 'Whether the service/vehicle type is offered by the tenant.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Spots assigned to this vehicle type (ignored for non-vehicle codes).',
    minimum: 0,
    example: 40,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  spots?: number;
}
