import { ApiProperty } from '@nestjs/swagger';
import { StaffMemberDto } from './staff-member.dto';

/** Response of `GET /me/staff`. */
export class PaginatedStaffDto {
  @ApiProperty({
    type: [StaffMemberDto],
    description: 'People on this page, ordered by name then email.',
  })
  items: StaffMemberDto[];

  @ApiProperty({
    type: 'integer',
    description: '1-based page number.',
    example: 1,
  })
  page: number;

  @ApiProperty({ type: 'integer', description: 'Items per page.', example: 20 })
  pageSize: number;

  @ApiProperty({
    type: 'integer',
    description: 'Total matching **people** (not memberships).',
    example: 7,
  })
  total: number;
}
