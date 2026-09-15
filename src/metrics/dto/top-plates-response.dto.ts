import { ApiProperty } from '@nestjs/swagger';
import type { TopPlatesOrder } from './top-plates-query.dto';

/** Aggregated activity of one plate over the window. */
export class TopPlateDto {
  @ApiProperty({
    description: 'Vehicle plate, upper-cased.',
    example: 'AB123CD',
  })
  plate: string;

  @ApiProperty({
    type: Number,
    description: 'Total left behind across every stay in the window, in ARS.',
    example: 18500,
  })
  revenue: number;

  @ApiProperty({
    type: 'integer',
    description: 'Stays closed in the window.',
    example: 7,
  })
  visits: number;

  @ApiProperty({
    type: 'integer',
    description: 'Minutes parked, summed across those stays.',
    example: 1260,
  })
  totalMinutes: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Mean stay length in minutes (`totalMinutes / visits`, rounded).',
    example: 180,
  })
  averageMinutes: number;
}

/** Response of `GET /tenants/:tenantId/metrics/top-plates`. */
export class TopPlatesResponseDto {
  @ApiProperty({ format: 'date-time' })
  from: Date;

  @ApiProperty({ format: 'date-time' })
  to: Date;

  @ApiProperty({
    description: 'Currency of every monetary figure.',
    example: 'ARS',
  })
  currency: string;

  @ApiProperty({
    enum: ['revenue', 'visits', 'duration'],
    description: 'Criterion the list is sorted by, descending.',
    example: 'revenue',
  })
  orderBy: TopPlatesOrder;

  @ApiProperty({
    type: [TopPlateDto],
    description: [
      'Ranked plates, best first.',
      '',
      'Built from stays that **ended** inside the window, since an open stay has neither a final amount nor a known duration. A vehicle still parked will not appear until it leaves.',
    ].join('\n'),
  })
  items: TopPlateDto[];
}
