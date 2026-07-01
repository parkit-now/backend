import { ApiPropertyOptional } from '@nestjs/swagger';
import { LprDetectionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListLprDetectionEventsQueryDto {
  @ApiPropertyOptional({ enum: LprDetectionStatus })
  @IsOptional()
  @IsEnum(LprDetectionStatus)
  status?: LprDetectionStatus;

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
