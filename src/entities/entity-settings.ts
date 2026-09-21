import type { Prisma } from '@prisma/client';
import type {
  DesktopCameraConfigDto,
  EntityCapacityDto,
  TicketTemplateDto,
  TicketTemplateFieldDto,
} from './dto/entity-profile.dto';

/**
 * Vista tipada de `Tenant.settings` (una columna JSON libre). Hoy sólo lleva la
 * capacidad total del estacionamiento; si aparecen settings estructurados
 * nuevos, van acá para que lecturas y escrituras queden type-checked.
 */
export interface EntitySettings {
  capacity?: EntityCapacityDto;
  ticketTemplate?: TicketTemplateDto;
  desktopCameraConfig?: DesktopCameraConfigDto;
}

const ZERO_CAPACITY: EntityCapacityDto = { total: 0 };
const TICKET_TEMPLATE_FIELD_IDS = new Set([
  'parkingName',
  'parkingAddress',
  'parkingCuit',
  'grossIncome',
  'nonFiscalControl',
  'ticketNumber',
  'plate',
  'vehicleBrand',
  'vehicleModel',
  'color',
  'rate',
  'entryDate',
  'entryTime',
  'cochera',
  'notes',
]);

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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readTicketTemplateField(
  value: unknown,
): TicketTemplateFieldDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !TICKET_TEMPLATE_FIELD_IDS.has(item.id)) {
    return null;
  }
  return {
    id: item.id,
    visible: item.visible === true,
    fontSizePt:
      typeof item.fontSizePt === 'number' && Number.isFinite(item.fontSizePt)
        ? item.fontSizePt
        : 10,
    emphasis: item.emphasis === 'bold' ? 'bold' : 'normal',
  };
}

export function readTicketTemplate(
  settings: Prisma.JsonValue,
): TicketTemplateDto | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return null;
  }
  const raw = (settings as Record<string, unknown>).ticketTemplate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const fields = Array.isArray(value.fields)
    ? value.fields
        .map(readTicketTemplateField)
        .filter((field): field is TicketTemplateFieldDto => field !== null)
    : [];
  if (fields.length === 0) return null;

  return {
    version: 1,
    fields,
    cuitOverride: asString(value.cuitOverride),
    grossIncomeText: asString(value.grossIncomeText),
    nonFiscalControlText: asString(value.nonFiscalControlText),
  };
}

/** Devuelve un objeto de settings nuevo con `ticketTemplate` mergeado. */
export function withTicketTemplate(
  settings: Prisma.JsonValue,
  ticketTemplate: TicketTemplateDto,
): Prisma.InputJsonValue {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  return {
    ...base,
    ticketTemplate,
  } as unknown as Prisma.InputJsonValue;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readDesktopCameraConfig(
  settings: Prisma.JsonValue,
): DesktopCameraConfigDto | null {
  const root = asRecord(settings);
  const value = asRecord(root?.desktopCameraConfig);
  if (!value) return null;
  const mode =
    value.mode === 'ip' || value.mode === 'webcam' ? value.mode : null;
  if (!mode) return null;
  const location = value.location === 'salida' ? 'salida' : 'entrada';
  const tuning = asRecord(value.tuning);

  return {
    mode,
    deviceIndex: Math.max(0, Math.trunc(asNumber(value.deviceIndex, 0))),
    host: asString(value.host),
    port: Math.min(65535, Math.max(1, Math.trunc(asNumber(value.port, 554)))),
    username: asString(value.username),
    streamPath: asString(value.streamPath) || '/h264_stream',
    cameraId: asString(value.cameraId) || 'cam-01',
    location,
    tuning,
  };
}

/** Devuelve un objeto de settings nuevo con `desktopCameraConfig` mergeado. */
export function withDesktopCameraConfig(
  settings: Prisma.JsonValue,
  desktopCameraConfig: DesktopCameraConfigDto,
): Prisma.InputJsonValue {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  return {
    ...base,
    desktopCameraConfig,
  } as unknown as Prisma.InputJsonValue;
}
