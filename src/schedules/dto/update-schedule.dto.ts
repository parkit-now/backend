import { ApiPropertyOptional } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateScheduleDto {
  @ApiPropertyOptional({
    description: 'Day of the week this opening range belongs to.',
    enum: ScheduleDay,
    example: ScheduleDay.tuesday,
  })
  @IsOptional()
  @IsEnum(ScheduleDay)
  day?: ScheduleDay;

  @ApiPropertyOptional({
    description: 'Opening time as minutes since midnight (0..1439).',
    minimum: 0,
    maximum: 1439,
    example: 540,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  openMinute?: number;

  @ApiPropertyOptional({
    description:
      'Closing time as minutes since midnight (1..1440; 1440 = midnight).',
    minimum: 1,
    maximum: 1440,
    example: 1260,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  closeMinute?: number;
}
