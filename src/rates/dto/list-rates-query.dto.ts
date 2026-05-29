import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

function parseBoolean(value: unknown): boolean | unknown {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class ListRatesQueryDto {
  @ApiPropertyOptional({
    description: 'Include disabled rates in the response.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => parseBoolean(value))
  @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional({
    description: 'Include soft-deleted rates in the response.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => parseBoolean(value))
  @IsBoolean()
  includeDeleted?: boolean;
}
