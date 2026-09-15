import type { Prisma } from '@prisma/client';
import {
  EntityAddressDto,
  GEOCODING_SOURCES,
  UpdateEntityAddressDto,
  type GeocodingSource,
} from './dto/entity-address.dto';

/**
 * Las columnas de `tenants` que forman la dirección. Se declara acá (en vez de
 * pedir un `Tenant` entero) para que los tres caminos de alta de tenants
 * —aprobación de solicitud, alta directa del admin y edición de perfil— usen
 * el MISMO mapeo sin arrastrar el modelo completo.
 */
export interface TenantAddressColumns {
  address: string | null;
  streetName: string | null;
  streetNumber: string | null;
  floor: string | null;
  cityName: string | null;
  stateName: string | null;
  postalCode: string | null;
  latitude: Prisma.Decimal | number | null;
  longitude: Prisma.Decimal | number | null;
  geocodingSource: string | null;
  geocodedAt: Date | null;
}

/** Nombres de las columnas de dirección, sin `address` (ver `resolveAddressLine`). */
type TenantAddressField =
  | 'streetName'
  | 'streetNumber'
  | 'floor'
  | 'cityName'
  | 'stateName'
  | 'postalCode'
  | 'latitude'
  | 'longitude'
  | 'geocodingSource'
  | 'geocodedAt';

type TenantAddressUpdate = Pick<Prisma.TenantUpdateInput, TenantAddressField>;
type TenantAddressCreate = Required<
  Pick<Prisma.TenantCreateInput, TenantAddressField>
>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `numeric` vuelve de Prisma como `Decimal`. Se expone como `number` igual que
 * los precios (`rates.service.ts`, `entries.service.ts`): el contrato HTTP es
 * JSON y seis decimales entran holgados en un `double`.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function source(value: unknown): GeocodingSource | null {
  return GEOCODING_SOURCES.includes(value as GeocodingSource)
    ? (value as GeocodingSource)
    : null;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Fila de `tenants` → el objeto `location` que ve el cliente. */
export function toEntityAddressDto(
  tenant: TenantAddressColumns,
): EntityAddressDto {
  return {
    formatted: tenant.address,
    streetName: tenant.streetName,
    streetNumber: tenant.streetNumber,
    floor: tenant.floor,
    cityName: tenant.cityName,
    stateName: tenant.stateName,
    postalCode: tenant.postalCode,
    latitude: num(tenant.latitude),
    longitude: num(tenant.longitude),
    geocodingSource: source(tenant.geocodingSource),
    geocodedAt: isoDate(tenant.geocodedAt),
  };
}

/**
 * Patch de las columnas de dirección: sólo las claves presentes en el DTO.
 * Omitir un campo lo deja como está; mandar `null` lo borra.
 */
export function addressUpdateData(
  location: UpdateEntityAddressDto,
): TenantAddressUpdate {
  const data: TenantAddressUpdate = {};
  if (location.streetName !== undefined) data.streetName = location.streetName;
  if (location.streetNumber !== undefined) {
    data.streetNumber = location.streetNumber;
  }
  if (location.floor !== undefined) data.floor = location.floor;
  if (location.cityName !== undefined) data.cityName = location.cityName;
  if (location.stateName !== undefined) data.stateName = location.stateName;
  if (location.postalCode !== undefined) data.postalCode = location.postalCode;
  if (location.latitude !== undefined) data.latitude = location.latitude;
  if (location.longitude !== undefined) data.longitude = location.longitude;
  if (location.geocodingSource !== undefined) {
    data.geocodingSource = location.geocodingSource;
  }
  if (location.geocodedAt !== undefined) {
    data.geocodedAt = location.geocodedAt
      ? new Date(location.geocodedAt)
      : null;
  }
  return data;
}

/**
 * Igual que `addressUpdateData` pero para un INSERT: todas las columnas
 * explícitas en `null` cuando no vienen, así el alta no depende de defaults.
 */
export function addressCreateData(
  location?: UpdateEntityAddressDto,
): TenantAddressCreate {
  return {
    streetName: location?.streetName ?? null,
    streetNumber: location?.streetNumber ?? null,
    floor: location?.floor ?? null,
    cityName: location?.cityName ?? null,
    stateName: location?.stateName ?? null,
    postalCode: location?.postalCode ?? null,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    geocodingSource: location?.geocodingSource ?? null,
    geocodedAt: location?.geocodedAt ? new Date(location.geocodedAt) : null,
  };
}

/**
 * Valor de la columna `address` (la línea de display) en un INSERT.
 *
 * `location.formatted` GANA sobre el `address` plano: el plano es el contrato
 * viejo que se conserva por retrocompatibilidad, `formatted` es el que trae la
 * `nomenclatura` normalizada. Mandar los dos distintos es un bug del cliente;
 * que gane siempre el mismo lo hace al menos determinístico.
 */
export function resolveAddressLine(
  address: string | null | undefined,
  location?: UpdateEntityAddressDto,
): string | null {
  return location?.formatted ?? address ?? null;
}

/**
 * Lee la dirección de un `declared_entity` (la columna JSON del wizard de
 * onboarding) TOLERANDO la forma vieja.
 *
 * Hay borradores en vuelo que sólo tienen `address` como string plano: se
 * mapean a `formatted` y el resto queda en `null`, en vez de romper o de
 * perder la dirección al aprobar. Mismo criterio que `readCapacity()` con la
 * forma legacy `carSpots`/`motorcycleSpots` en `entity-settings.ts`.
 *
 * Devuelve la forma de LECTURA (todos los campos presentes, en `null` cuando
 * faltan) porque se usa para dos cosas: mostrarle al revisor qué dirección
 * declaró el solicitante, y materializarla en `tenants` al aprobar.
 */
export function readDeclaredAddress(
  entity: Record<string, unknown>,
): EntityAddressDto {
  const raw = entity.location;
  const loc: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // Forma vieja: sólo `address` a nivel raíz, sin objeto `location`.
  const formatted = str(loc.formatted) ?? str(entity.address);

  // El par de coordenadas se acepta sólo completo: la base rechaza media
  // coordenada (`tenants_coordinates_paired`) y un borrador viejo o a medio
  // llenar no tiene por qué reventar la aprobación.
  const latitude = num(loc.latitude);
  const longitude = num(loc.longitude);
  const paired = latitude !== null && longitude !== null;

  return {
    formatted,
    streetName: str(loc.streetName),
    streetNumber: str(loc.streetNumber),
    floor: str(loc.floor),
    cityName: str(loc.cityName),
    stateName: str(loc.stateName),
    postalCode: str(loc.postalCode),
    latitude: paired ? latitude : null,
    longitude: paired ? longitude : null,
    geocodingSource: source(loc.geocodingSource),
    geocodedAt: isoDate(loc.geocodedAt),
  };
}

/**
 * Los campos que hacen falta cuando la dirección NO la normalizó Georef.
 *
 * Espejo de `REQUIRED_MANUAL_FIELDS`
 * (`front-web/src/shared/components/AddressPicker/addressUtils.ts`): son
 * exactamente los que Mercado Pago pide para la ubicación del `Store`
 * (`street_name`, `street_number`, `city_name`, `state_name`).
 *
 * Quedan AFUERA a propósito, con el mismo criterio que el front:
 *  - `floor`: no lo usa la ubicación del Store.
 *  - `postalCode`: Georef NO lo devuelve. Exigirlo a mano haría la carga
 *    manual más estricta que el propio autocompletado.
 *  - `latitude`/`longitude`: nadie las tipea. Sin Georef no hay coordenadas, y
 *    frenar un alta porque una API del Estado está caída es justo lo que no se
 *    puede hacer.
 */
export const REQUIRED_DECLARED_ADDRESS_FIELDS = [
  'streetName',
  'streetNumber',
  'cityName',
  'stateName',
] as const satisfies readonly (keyof EntityAddressDto)[];

export type RequiredDeclaredAddressField =
  (typeof REQUIRED_DECLARED_ADDRESS_FIELDS)[number];

/**
 * Qué le falta a una dirección declarada para considerarse COMPLETA.
 * Lista vacía = está completa.
 *
 * Misma regla que `validateAddress()` del wizard
 * (`front-web/src/features/onboarding/validation.ts`), con dos caminos
 * válidos:
 *
 *   1. Georef la normalizó: `geocodingSource === 'georef'` y hay línea de
 *      display. La persona no tocó un solo campo.
 *   2. La cargó a mano y completó calle, altura, localidad y provincia.
 *
 * "Obligatorio" es que el CAMPO esté completo, NO que Georef haya funcionado:
 * una API pública caída no puede frenar un alta.
 *
 * OJO con la forma vieja: un borrador que sólo trae el `address` plano
 * (string de una línea, sin `location`) NO pasa. Es deliberado y es el mismo
 * criterio que el front — una línea de texto libre no alcanza para la
 * ubicación del Store de Mercado Pago, que es para lo que se pide la
 * dirección. El mensaje de error nombra los cuatro campos que faltan, así que
 * quien tenga un borrador viejo ve exactamente qué completar.
 *
 * La obligatoriedad es de la TRANSICIÓN a revisión, no del esquema ni del DTO:
 * las columnas de `tenants` siguen siendo nullable, hay tenants viejos con
 * `null`, y un borrador incompleto se puede seguir guardando y editando.
 */
export function missingDeclaredAddressFields(
  address: EntityAddressDto,
): RequiredDeclaredAddressField[] {
  const georefNormalized =
    address.geocodingSource === 'georef' &&
    (address.formatted ?? '').trim().length > 0;
  if (georefNormalized) return [];

  return REQUIRED_DECLARED_ADDRESS_FIELDS.filter(
    (field) => (address[field] ?? '').trim().length === 0,
  );
}

/**
 * `['streetName','stateName']` → `'streetName and stateName'`.
 *
 * En INGLÉS y con el nombre del campo tal como viaja en el JSON, porque va al
 * `detail` del ProblemDetails, que por contrato del repo es para logs y no se
 * le muestra al usuario (AGENTS.md, "Contrato de errores HTTP"). El texto en
 * español lo arma el cliente a partir del `code` y de `validationsErrors`; NO
 * se duplican acá las etiquetas del wizard.
 */
export function describeMissingAddressFields(
  missing: readonly RequiredDeclaredAddressField[],
): string {
  if (missing.length <= 1) return missing[0] ?? '';
  return `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
}
