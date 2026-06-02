import { ApiProperty } from '@nestjs/swagger';
import { ParkingDto } from './parking.dto';

/** One page of parking lots plus the totals needed to render pagination. */
export class PaginatedParkingsDto {
  @ApiProperty({ type: ParkingDto, isArray: true })
  items: ParkingDto[];

  @ApiProperty({
    type: 'integer',
    description: 'Total number of parking lots matching the query.',
    example: 42,
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
