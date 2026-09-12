import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateServiceDto {
  @ApiPropertyOptional({
    description: 'Whether the amenity is offered by the tenant.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
