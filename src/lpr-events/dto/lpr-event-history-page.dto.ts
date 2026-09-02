import { ApiProperty } from '@nestjs/swagger';
import { LprEventHistoryItemDto } from './lpr-event-history-item.dto';

/** One page of LPR event history plus the totals needed to render pagination. */
export class LprEventHistoryPageDto {
  @ApiProperty({ type: LprEventHistoryItemDto, isArray: true })
  items: LprEventHistoryItemDto[];

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
