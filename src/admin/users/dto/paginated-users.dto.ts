import { ApiProperty } from '@nestjs/swagger';
import { AdminUserDto } from './admin-user.dto';

/** One page of users plus the totals needed to render pagination. */
export class PaginatedUsersDto {
  @ApiProperty({ type: AdminUserDto, isArray: true })
  items: AdminUserDto[];

  @ApiProperty({
    type: 'integer',
    description: 'Total number of users matching the query.',
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
