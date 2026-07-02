import { ApiPropertyOptional } from '@nestjs/swagger';
import { LprDetectionStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class ListLprDetectionEventsQueryDto {
  @ApiPropertyOptional({ enum: LprDetectionStatus })
  @IsOptional()
  @IsEnum(LprDetectionStatus)
  status?: LprDetectionStatus;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'When false (default), archived LPR events are hidden from review lists. Set true to list archived events instead.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    const raw = value as unknown;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  })
  @IsBoolean()
  archived = false;

  @ApiPropertyOptional({
    type: Number,
    default: 100,
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;
}
