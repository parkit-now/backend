import { ApiPropertyOptional } from '@nestjs/swagger';
import { LprDetectionStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';

export class ListLprDetectionEventsQueryDto extends PaginationQueryDto {
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
    format: 'date-time',
    description:
      'Only include events first detected at or after this timestamp (ISO 8601, inclusive).',
  })
  @IsOptional()
  @IsDateString()
  firstSeenFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only include events first detected at or before this timestamp (ISO 8601, inclusive).',
  })
  @IsOptional()
  @IsDateString()
  firstSeenTo?: string;
}
