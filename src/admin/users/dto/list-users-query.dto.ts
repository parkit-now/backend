import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../utils/pagination/pagination-query.dto';

/** Query for the admin user list: free-text search + pagination. */
export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Case-insensitive search matched against the user name and email.',
    example: 'ana',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}
