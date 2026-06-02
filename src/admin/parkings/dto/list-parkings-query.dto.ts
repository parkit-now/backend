import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../utils/pagination/pagination-query.dto';

/** Query for the admin parking-lot list: free-text search + pagination. */
export class ListParkingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Case-insensitive search matched against the parking name and address. ' +
      'Powers both the inventory table and the membership autocomplete.',
    example: 'centro',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}
