import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

function parseBoolean(value: unknown): boolean | unknown {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class RateChangesQueryDto {
  @ApiPropertyOptional({
    description: 'Return rows with syncSeq greater than this value.',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq = 0;

  @ApiPropertyOptional({
    description: 'Max items per page.',
    default: 200,
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 200;

  @ApiPropertyOptional({
    description: 'Include deleted rows in the changes feed.',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => parseBoolean(value))
  @IsBoolean()
  includeDeleted?: boolean;
}
