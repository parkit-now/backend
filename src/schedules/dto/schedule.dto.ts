import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDay } from '@prisma/client';

export class ScheduleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ enum: ScheduleDay })
  day: ScheduleDay;

  @ApiProperty({
    type: Number,
    description: 'Minutes since midnight (0..1439).',
  })
  openMinute: number;

  @ApiProperty({
    type: Number,
    description: 'Minutes since midnight (1..1440).',
  })
  closeMinute: number;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
