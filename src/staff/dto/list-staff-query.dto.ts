import { ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';

/** Filters for the owner's staff table. */
export class ListStaffQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Case-insensitive search matched against the person’s name and email.',
    example: 'ana',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    enum: MembershipRole,
    description: [
      'Keep only people holding this role in at least one of the caller’s lots.',
      '',
      'It selects **who** appears, not what is shown: a matching person still lists every membership they hold within the caller’s lots, so someone who is `operator` in one branch and `owner` in another appears under either filter with both roles visible.',
    ].join('\n'),
    example: 'operator',
  })
  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Narrow to a single lot. Must be one the caller owns, otherwise the request is rejected.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
