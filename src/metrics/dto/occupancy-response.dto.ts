import { ApiProperty } from '@nestjs/swagger';

/**
 * Where the occupancy denominator came from.
 *
 * The lot's spot count lives in two places that drifted apart: `services.spots`
 * (per `ServiceCode`, edited from the services config screen) and
 * `tenant.settings.capacity` (edited from the entity profile). Both are seeded
 * from the same declared numbers when an application is approved, but neither
 * write path syncs the other. Metrics prefer `services` and fall back to
 * `settings`; this field tells the client which one produced the number, so a
 * mismatch is diagnosable from the dashboard instead of silently wrong.
 */
export type CapacitySource = 'services' | 'settings' | 'none';

/** Live occupancy of the lot. Shared by `/metrics/occupancy` and `/metrics/summary`. */
export class OccupancyDto {
  @ApiProperty({
    type: 'integer',
    description:
      'Total spots. `0` when the lot has configured neither services nor profile capacity.',
    example: 100,
  })
  capacity: number;

  @ApiProperty({
    enum: ['services', 'settings', 'none'],
    description:
      'Which configuration produced `capacity`: enabled `services.spots`, the profile `settings.capacity` fallback, or neither.',
    example: 'services',
  })
  capacitySource: CapacitySource;

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
      'Vehicle type of the open entries, or `unknown` when the entry never declared one.',
    example: 'auto',
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
      'Two caveats the UI must respect: `vehicleType` is only populated on LPR ingress (`source = "auto"`), so lots working manually report almost everything under `unknown`; and `ServiceCode` does not map 1:1 to `VehicleType`, so there is no per-type capacity to turn these counts into percentages.',
    ].join('\n'),
  })
  byVehicleType: OccupancyByVehicleTypeDto[];
}
