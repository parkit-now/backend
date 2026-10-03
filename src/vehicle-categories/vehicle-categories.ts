/**
 * Categorías de vehículo de la plataforma.
 *
 * Es el espejo en TypeScript de la tabla `vehicle_categories`
 * (supabase/migrations/20261005120000_vehicle_categories.sql). La lista es
 * CERRADA: se cambia sólo por migración, y `vehicle-categories.spec.ts` falla si
 * este archivo y el SQL se desincronizan.
 *
 * Los tipos de vehículo de cada estacionamiento tienen un nombre libre; la
 * categoría es lo que el catálogo, el conductor, las reservas, los ingresos y
 * las métricas usan de verdad.
 */
export const VEHICLE_CATEGORIES = [
  'car',
  'suv',
  'pickup',
  'van',
  'motorcycle',
  'bicycle',
  'truck',
  'other',
] as const;

export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];

/**
 * Las que se pueden reservar desde la app del conductor. Bici, camión y otro
 * quedan afuera. Mismo criterio que `vehicle_categories.reservable` y que el
 * CHECK de `services.reservation_vehicle_categories`.
 */
export const RESERVABLE_VEHICLE_CATEGORIES = [
  'car',
  'suv',
  'pickup',
  'van',
  'motorcycle',
] as const satisfies readonly VehicleCategory[];

export type ReservableVehicleCategory =
  (typeof RESERVABLE_VEHICLE_CATEGORIES)[number];

export interface VehicleCategoryInfo {
  code: VehicleCategory;
  label: string;
  sortOrder: number;
  reservable: boolean;
}

/** Contenido de `vehicle_categories`, en orden. */
export const VEHICLE_CATEGORY_INFO: readonly VehicleCategoryInfo[] = [
  { code: 'car', label: 'Auto', sortOrder: 1, reservable: true },
  { code: 'suv', label: 'SUV', sortOrder: 2, reservable: true },
  { code: 'pickup', label: 'Pickup', sortOrder: 3, reservable: true },
  { code: 'van', label: 'Utilitario / Van', sortOrder: 4, reservable: true },
  { code: 'motorcycle', label: 'Moto', sortOrder: 5, reservable: true },
  { code: 'bicycle', label: 'Bici', sortOrder: 6, reservable: false },
  { code: 'truck', label: 'Camión', sortOrder: 7, reservable: false },
  { code: 'other', label: 'Otro', sortOrder: 8, reservable: false },
];

export function isVehicleCategory(value: unknown): value is VehicleCategory {
  return (
    typeof value === 'string' &&
    (VEHICLE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Nombre normalizado: minúsculas, acentos plegados y fuera todo lo que no sea
 * [a-z0-9]. Así "Pick-up", "PICKUP" y "pick up" son la misma cosa, y "Utilitario
 * / Van" queda `utilitariovan`.
 *
 * Es la misma normalización que usa el SQL de la migración (`translate` +
 * `lower` + `regexp_replace('[^a-z0-9]')`).
 */
export function normalizeVehicleTypeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Alias por nombre normalizado -> categoría. Duplicado en el backfill de la
 * migración 20261005120000 y en scripts/sql/preview-vehicle-categories.sql; el
 * spec compara las tres listas.
 *
 * "Camioneta" NO está a propósito: en Argentina es tanto una SUV como una
 * pickup, así que no se adivina por el nombre.
 */
export const VEHICLE_CATEGORY_ALIASES: Readonly<
  Record<string, VehicleCategory>
> = {
  auto: 'car',
  autos: 'car',
  automovil: 'car',
  automoviles: 'car',
  coche: 'car',
  coches: 'car',
  suv: 'suv',
  suvs: 'suv',
  crossover: 'suv',
  '4x4': 'suv',
  pickup: 'pickup',
  pickups: 'pickup',
  van: 'van',
  vans: 'van',
  utilitario: 'van',
  utilitarios: 'van',
  utilitariovan: 'van',
  furgon: 'van',
  furgones: 'van',
  furgoneta: 'van',
  furgonetas: 'van',
  moto: 'motorcycle',
  motos: 'motorcycle',
  motocicleta: 'motorcycle',
  motocicletas: 'motorcycle',
  ciclomotor: 'motorcycle',
  ciclomotores: 'motorcycle',
  bici: 'bicycle',
  bicis: 'bicycle',
  bicicleta: 'bicycle',
  bicicletas: 'bicycle',
  camion: 'truck',
  camiones: 'truck',
  otro: 'other',
  otros: 'other',
};

/**
 * Adivina la categoría de un tipo por su nombre, o `null` si no la reconoce
 * ("Camioneta", "pepe"). Es el paso (a) del backfill; el que llama decide qué
 * hacer con el `null` (en el alta de un tipo sin categoría: `other` marcado
 * como inferido).
 */
export function inferCategoryFromName(name: string): VehicleCategory | null {
  return VEHICLE_CATEGORY_ALIASES[normalizeVehicleTypeName(name)] ?? null;
}
