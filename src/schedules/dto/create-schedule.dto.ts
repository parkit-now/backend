import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

export class CreateScheduleDto {
  @ApiProperty({
    description: 'Day of the week this opening range belongs to.',
    enum: ScheduleDay,
    example: ScheduleDay.monday,
  })
  @IsEnum(ScheduleDay)
  day: ScheduleDay;

  @ApiProperty({
    description: 'Opening time as minutes since midnight (0..1439).',
    minimum: 0,
    maximum: 1439,
    example: 480,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1439)
  openMinute: number;

  @ApiProperty({
    description:
      'Closing time as minutes since midnight (1..1440; 1440 = midnight).',
    minimum: 1,
    maximum: 1440,
    example: 1200,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  closeMinute: number;
}
