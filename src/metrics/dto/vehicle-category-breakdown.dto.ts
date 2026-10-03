import { ApiProperty } from '@nestjs/swagger';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import type { VehicleCategory } from '../../vehicle-categories/vehicle-categories';

/** One slice of the vehicle-category pie. */
export class VehicleCategorySliceDto {
  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    nullable: true,
    description:
      'Platform vehicle category, as frozen on the stay at ingress. `null` is the "Sin dato" slice: stays that predate the categories, or that came from a till that does not send one.',
  })
  category: VehicleCategory | null;

  @ApiProperty({
    type: 'integer',
    description: 'Stays that ended in the window under this category.',
    example: 42,
  })
  stays: number;

  @ApiProperty({
    type: Number,
    description: 'Revenue of those stays (`entries.amountPaid`), in ARS.',
    example: 12300,
  })
  revenue: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Share of the window total **stays**, `0`–`1`. Shares across every slice add up to 1. `null` when there are no stays.',
    example: 0.42,
  })
  share: number | null;
}

/** Response of `GET /tenants/:tenantId/metrics/by-vehicle-category`. */
export class VehicleCategoryBreakdownDto {
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
    type: 'integer',
    description: 'Stays that ended in the window (sum of every slice).',
  })
  totalStays: number;

  @ApiProperty({
    type: Number,
    description: 'Revenue of those stays, in ARS (sum of every slice).',
  })
  totalRevenue: number;

  @ApiProperty({
    type: [VehicleCategorySliceDto],
    description:
      'One slice per category present in the window, most stays first, with the `null` ("Sin dato") slice last.',
  })
  categories: VehicleCategorySliceDto[];
}
