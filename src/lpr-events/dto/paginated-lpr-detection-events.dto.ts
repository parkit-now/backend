import { ApiProperty } from '@nestjs/swagger';
import { LprDetectionEventDto } from './lpr-detection-event.dto';

export class PaginatedLprDetectionEventsDto {
  @ApiProperty({ type: LprDetectionEventDto, isArray: true })
  items: LprDetectionEventDto[];

  @ApiProperty({
    type: 'integer',
    description: 'Total number of events matching the query.',
    example: 128,
  })
  total: number;

  @ApiProperty({
    type: 'integer',
    description: 'Current 1-based page.',
    example: 1,
  })
  page: number;

  @ApiProperty({ type: 'integer', description: 'Items per page.', example: 20 })
  pageSize: number;
}
