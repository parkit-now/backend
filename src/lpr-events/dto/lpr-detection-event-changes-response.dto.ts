import { ApiProperty } from '@nestjs/swagger';
import { LprDetectionEventDto } from './lpr-detection-event.dto';

export class LprDetectionEventChangesResponseDto {
  @ApiProperty({ type: () => [LprDetectionEventDto] })
  items: LprDetectionEventDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
