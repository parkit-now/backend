import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export type ApplicationStatusFilter = 'pending' | 'approved' | 'rejected';

export class ListApplicationsQueryDto {
  @ApiPropertyOptional({
    enum: ['pending', 'approved', 'rejected'],
    description:
      'Filter the queue by external status. `pending` maps to the internal `pending_review` state. Omit to return all submitted applications (drafts are always excluded).',
    example: 'pending',
  })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ApplicationStatusFilter;
}
