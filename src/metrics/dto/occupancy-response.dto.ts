import { ApiProperty } from '@nestjs/swagger';

/** Live occupancy of the lot. Shared by `/metrics/occupancy` and `/metrics/summary`. */
export class OccupancyDto {
  @ApiProperty({
    type: 'integer',
    description:
      'Total spots, from `tenant.settings.capacity.total` (the entity profile). `0` when the lot has not declared its capacity yet.',
    example: 100,
  })
  capacity: number;

  @ApiProperty({
    type: 'integer',
    description: 'Vehicles currently inside (entries with no `leftAt`).',
    example: 63,
  })
  occupied: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Free spots, or `null` when capacity is unknown. Floored at 0 — a lot can be overbooked past its configured capacity.',
    example: 37,
  })
  free: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Occupied over capacity, `0`–`1` (may exceed 1 if overbooked). `null` when capacity is unknown, so the client can show "sin configurar" instead of a fake 0%.',
    example: 0.63,
  })
  occupancyPct: number | null;
}

/** Count of vehicles currently inside, grouped by declared vehicle type. */
export class OccupancyByVehicleTypeDto {
  @ApiProperty({
    description:
      'Vehicle type of the open entries — the name snapshotted from the tenant’s `vehicle-types` catalogue at ingress — or `unknown` when the entry never declared one.',
    example: 'Auto',
  })
  type: string;

  @ApiProperty({ type: 'integer', description: 'Open entries of this type.' })
  occupied: number;
}

/** Response of `GET /tenants/:tenantId/metrics/occupancy`. */
export class OccupancyResponseDto extends OccupancyDto {
  @ApiProperty({
    type: [OccupancyByVehicleTypeDto],
    description: [
      'Open entries grouped by `vehicleType`, most occupied first. **Best effort, counts only.**',
      '',
      'Two caveats the UI must respect: `vehicleType` is only populated on LPR ingress (`source = "auto"`), so lots working manually report almost everything under `unknown`; and capacity is a single lot-wide total, not a per-type quota, so these counts cannot be turned into percentages.',
      '',
      'The names come from the entries themselves, not from the live catalogue: a type the owner has since renamed or deleted still shows up here under the name it had at ingress.',
    ].join('\n'),
  })
  byVehicleType: OccupancyByVehicleTypeDto[];
}
