import { ApiProperty } from '@nestjs/swagger';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';

/** One slice of the vehicle-category pie. */
export class VehicleCategorySliceDto {
  @ApiProperty({
    enum: [...VEHICLE_CATEGORIES, 'reservation_unused'],
    enumName: 'VehicleCategorySliceKey',
    nullable: true,
    description:
      'Platform vehicle category, as frozen on the stay at ingress. `null` is the "Sin dato" slice: stays that predate the categories, or that came from a till that does not send one. `reservation_unused` ("Reservas sin uso") is the reservation money with no stay behind it (no-show, partial cancel): `stays` 0, only present when > 0, so the total matches `revenue/by-payment-method`.',
  })
  category: VehicleCategory | 'reservation_unused' | null;

  @ApiProperty({
    type: 'integer',
    description: 'Stays that ended in the window under this category.',
    example: 42,
  })
  stays: number;

  @ApiProperty({
    type: Number,
    description:
      'Revenue of those stays (`entries.amountPaid` plus the reservation prepayment), in ARS.',
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
