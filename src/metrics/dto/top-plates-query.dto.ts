import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MetricsWindowQueryDto } from './metrics-window-query.dto';

/** What makes a plate "top" in the ranking. */
export type TopPlatesOrder = 'revenue' | 'visits' | 'duration';

const ORDERS: TopPlatesOrder[] = ['revenue', 'visits', 'duration'];

/** Window + ranking options for the top-plates table. */
export class TopPlatesQueryDto extends MetricsWindowQueryDto {
  @ApiPropertyOptional({
    enum: ORDERS,
    default: 'revenue',
    description: [
      'Ranking criterion: money left behind (`revenue`), number of stays (`visits`), or time parked (`duration`).',
      '',
      'Every metric is returned regardless, so switching the ranking is a re-sort rather than a different dataset.',
    ].join('\n'),
    example: 'revenue',
  })
  @IsOptional()
  @IsIn(ORDERS)
  orderBy?: TopPlatesOrder = 'revenue';

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 50,
    default: 10,
    description: 'How many plates to return.',
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}
