import type { Prisma } from '@prisma/client';
import type { EntityCapacityDto } from './dto/entity-profile.dto';

/**
 * Typed view of `Tenant.settings` (a free-form JSON column). Today it only
 * carries the per-vehicle-type spot `capacity` (the `zones` table was removed);
 * keep new structured settings here so reads/writes stay type-checked.
 */
export interface EntitySettings {
  capacity?: EntityCapacityDto;
}

const ZERO_CAPACITY: EntityCapacityDto = {
  carSpots: 0,
  motorcycleSpots: 0,
  bicycleSpots: 0,
};

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** Reads `settings.capacity`, defaulting any missing type to `0`. */
export function readCapacity(settings: Prisma.JsonValue): EntityCapacityDto {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ...ZERO_CAPACITY };
  }
  const capacity = (settings as Record<string, unknown>).capacity;
  if (!capacity || typeof capacity !== 'object') {
    return { ...ZERO_CAPACITY };
  }
  const c = capacity as Record<string, unknown>;
  return {
    carSpots: asInt(c.carSpots),
    motorcycleSpots: asInt(c.motorcycleSpots),
    bicycleSpots: asInt(c.bicycleSpots),
  };
}

/** Returns a new settings object with `capacity` merged in. */
export function withCapacity(
  settings: Prisma.JsonValue,
  capacity: EntityCapacityDto,
): Prisma.InputJsonValue {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  return { ...base, capacity } as unknown as Prisma.InputJsonValue;
}
