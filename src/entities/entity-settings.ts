import type { Prisma } from '@prisma/client';
import type { EntityCapacityDto } from './dto/entity-profile.dto';

/**
 * Vista tipada de `Tenant.settings` (una columna JSON libre). Hoy sólo lleva la
 * capacidad total del estacionamiento; si aparecen settings estructurados
 * nuevos, van acá para que lecturas y escrituras queden type-checked.
 */
export interface EntitySettings {
  capacity?: EntityCapacityDto;
}

const ZERO_CAPACITY: EntityCapacityDto = { total: 0 };

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/**
 * Lee `settings.capacity`, defaulteando a `0`.
 *
 * Tolera la forma VIEJA (`carSpots`/`motorcycleSpots`/`bicycleSpots`) sumándola:
 * la migración las colapsa, pero una fila escrita por un deploy viejo entre
 * medio devolvería `total: 0` en silencio, y un dueño con 55 plazas vería cero.
 * Es barato y evita un cero mentiroso.
 */
export function readCapacity(settings: Prisma.JsonValue): EntityCapacityDto {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ...ZERO_CAPACITY };
  }
  const capacity = (settings as Record<string, unknown>).capacity;
  if (!capacity || typeof capacity !== 'object') {
    return { ...ZERO_CAPACITY };
  }
  const c = capacity as Record<string, unknown>;

  if (c.total !== undefined) return { total: asInt(c.total) };

  const legacy =
    asInt(c.carSpots) + asInt(c.motorcycleSpots) + asInt(c.bicycleSpots);
  return { total: legacy };
}

/** Devuelve un objeto de settings nuevo con `capacity` mergeado. */
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
