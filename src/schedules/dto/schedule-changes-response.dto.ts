import { ApiProperty } from '@nestjs/swagger';
import { ScheduleDto } from './schedule.dto';

export class ScheduleChangesResponseDto {
  @ApiProperty({ type: () => [ScheduleDto] })
  items: ScheduleDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
