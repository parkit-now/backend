import { ApiPropertyOptional } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ListSchedulesQueryDto {
  @ApiPropertyOptional({
    description: 'Filter ranges by a single weekday.',
    enum: ScheduleDay,
  })
  @IsOptional()
  @IsEnum(ScheduleDay)
  day?: ScheduleDay;
}
