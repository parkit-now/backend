// Local-only tenant business seed.
//
// Siembra los datos de negocio de los tres estacionamientos de demo: perfil de
// la entidad (incluida la DIRECCIÓN ESTRUCTURADA), tipos y vehículos propios,
// tarifas, horarios, abonados, cajas, ingresos y sus cobros, y el onboarding.
// Idempotente — se puede correr todas las veces que haga falta.
//
// REGLA DE ORO DE ESTE ARCHIVO: los datos que escribe tienen que ser datos que
// la APLICACIÓN REAL podría haber escrito. Un seed que produce filas
// imposibles (un uuid que el cliente nunca generaría, un cobro sin
// transacción, una solicitud que el propio `submit()` rechazaría) hace probar
// contra un mundo que no existe, y eso es peor que no tener seed.
//
// Guardrails:
//   - Refuses to run unless SUPABASE_URL points to localhost / 127.0.0.1.
//   - Refuses to run without DATABASE_URL.
//   - Fails with a clear message if required tables are missing.
//
// Trigger: `make seed-tenant` o `bun run seed:tenant`.

import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type PaymentMethodType,
  type Prisma,
  type ScheduleDay,
  type ServiceCode,
} from '@prisma/client';
import { Pool } from 'pg';
import { withCapacity } from '../src/entities/entity-settings';
import { SYSTEM_PAYMENT_METHOD_DEFAULTS } from '../src/entities/system-payment-methods';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error('✗ Refusing to seed tenant data: SUPABASE_URL is not local.');
  console.error(`  SUPABASE_URL=${SUPABASE_URL || '(unset)'}`);
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('✗ Missing DATABASE_URL in env.');
  process.exit(1);
}

const TENANTS = {
  once: '11111111-1111-4111-8111-111111111111',
  belgrano: '22222222-2222-4222-8222-222222222222',
  palermo: '33333333-3333-4333-8333-333333333333',
} as const;

// ---------------------------------------------------------------------------
// Helpers de tiempo
// ---------------------------------------------------------------------------

/**
 * Argentina está en UTC-3 fijo (no hay horario de verano desde 2009), así que
 * alcanza con una constante. Importa porque las horas del fixture se leen en
 * pantalla en hora local: un ingreso "a las 08:20" cargado como 08:20 UTC se
 * ve a las 05:20 de la mañana, que no es hora de nadie en una playa.
 */
const ARGENTINA_UTC_OFFSET_HOURS = 3;

/** 00:00 de HOY en Argentina, expresado en UTC. */
function startOfArgentinaDay(now: Date): Date {
  const local = new Date(
    now.getTime() - ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000,
  );
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      ARGENTINA_UTC_OFFSET_HOURS,
    ),
  );
}

/**
 * Los movimientos (cajas, ingresos, cobros) se anclan al DÍA DE LA CORRIDA y
 * no a fechas fijas.
 *
 * Antes las estadías estaban clavadas en mayo de 2026: al correr el seed hoy
 * quedaban cuatro meses de "estadía activa" y el panel de ocupación, el arqueo
 * y los listados por fecha mostraban un estacionamiento que ninguna playa real
 * tendría. Los IDs sí son fijos (ver `seedUuidV7`), así que re-sembrar sigue
 * actualizando las MISMAS filas en vez de acumular basura.
 */
const TODAY = startOfArgentinaDay(new Date());

/** Fecha/hora ARGENTINA relativa a hoy: `at(-1, 8, 40)` = ayer 08:40. */
function at(dayOffset: number, hour: number, minute = 0): Date {
  return new Date(
    TODAY.getTime() +
      dayOffset * 24 * 60 * 60 * 1000 +
      hour * 60 * 60 * 1000 +
      minute * 60 * 1000,
  );
}

// ---------------------------------------------------------------------------
// Helpers de identidad
// ---------------------------------------------------------------------------

/**
 * Base fija del timestamp de los UUIDv7 del seed. Fija A PROPÓSITO: el id de un
 * fixture tiene que ser estable entre corridas para que el upsert actualice la
 * misma fila. Lo que importa es la FORMA, no el instante que codifica.
 */
const SEED_UUID_BASE_MS = Date.parse('2026-09-01T09:00:00.000Z');

/**
 * UUIDv7 determinístico para las tablas cuyo id lo genera el CLIENTE.
 *
 * `entries`, `rates`, `vehicles`, `vehicle_types`, `cash_sessions` y
 * `payment_transactions` documentan en el esquema que el id es un UUIDv7 que
 * manda el desktop (offline-first: la fila nace en el cliente). El seed viejo
 * usaba ids "decorativos" v4 (`eeeeeeee-eeee-4eee-…`), que ningún cliente
 * produce y que además no ordenan por tiempo — justo la propiedad por la que
 * se eligió v7.
 *
 * Layout v7: 48 bits de timestamp ms | versión 7 | variante 10xx. El nibble de
 * versión y el de variante importan de verdad: `@IsUUID()` de class-validator
 * exige versión 1-8 y variante 8/9/a/b, así que un uuid inventado a mano no
 * pasa el DTO y el fixture no se podría re-crear por la API.
 */
function seedUuidV7(seq: number): string {
  const ts = SEED_UUID_BASE_MS.toString(16).padStart(12, '0');
  const tail = seq.toString(16).padStart(12, '0');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7000-8000-${tail}`;
}

// Rangos de `seq` por tabla, para que los ids no se pisen entre sí y se
// reconozca de un vistazo de qué fixture viene cada fila.
const SEQ = {
  vehicleType: 1_000,
  vehicle: 2_000,
  rate: 3_000,
  cashSession: 4_000,
  entry: 5_000,
  payment: 6_000,
} as const;

// ---------------------------------------------------------------------------
// Helper de idempotencia real
// ---------------------------------------------------------------------------

function toTime(value: unknown): number {
  return value instanceof Date
    ? value.getTime()
    : new Date(value as string).getTime();
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}

/**
 * Comparación tolerante a `Decimal`, `Date` y números en string.
 *
 * `Decimal('4500.00').toString()` es `'4500'`, así que comparar textos daría
 * "cambió" contra el `'4500.00'` del fixture y el seed escribiría en cada
 * corrida. Por eso los numéricos se comparan como números.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) return toTime(a) === toTime(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return asText(a) === asText(b);
}

/**
 * ¿Hace falta escribir?
 *
 * TODAS las tablas de sync tienen un trigger `BEFORE UPDATE` que bumpea
 * `sync_seq`, `version` y `updated_at` en CADA update, aunque el UPDATE no
 * cambie un solo valor (Postgres dispara el trigger igual). El seed viejo
 * hacía `upsert` incondicional, así que cada `make seed-all` les rotaba la
 * versión al pedo: los métodos de pago de la base local estaban en `version=9`
 * sin que nadie los hubiera tocado nueve veces, y cada corrida mandaba filas
 * sin cambios por el sync incremental a todos los clientes.
 *
 * Con esto, re-sembrar sin cambios es un no-op de verdad.
 */
function needsUpdate(
  current: Record<string, unknown>,
  fields: Record<string, unknown>,
): boolean {
  return Object.entries(fields).some(([key, value]) => {
    return !sameValue(current[key], value);
  });
}

type Tally = { created: number; updated: number; unchanged: number };

function tally(): Tally {
  return { created: 0, updated: 0, unchanged: 0 };
}

function describe(label: string, t: Tally): string {
  return `✓ ${label}: ${t.created} nuevas, ${t.updated} actualizadas, ${t.unchanged} sin cambios.`;
}

// ---------------------------------------------------------------------------
// Perfil de las entidades (incluye la dirección estructurada)
// ---------------------------------------------------------------------------

/**
 * Direcciones REALES de CABA con sus coordenadas de verdad, tal como las
 * devuelve la API Georef del Estado
 * (`https://apis.datos.gob.ar/georef/api/direcciones?direccion=…`), que es la
 * misma que consulta el `AddressPicker` del panel web. De ahí salen la
 * `nomenclatura` (que va a `address`, el campo de display), el nombre de calle
 * EN MAYÚSCULAS y las coordenadas con 6 decimales.
 *
 * Los tres casos que existen en producción están representados a propósito:
 *
 *   1. `georef`  — el camino feliz: la API normalizó todo y nadie tocó nada.
 *                  Sin `postal_code`: Georef NO lo devuelve (por eso tampoco es
 *                  obligatorio en la carga manual).
 *   2. `manual`  — Georef resolvió la calle y después una persona corrigió: le
 *                  puso piso y CP, y arrastró el pin al portal real. El front
 *                  marca `manual` SIEMPRE que se toca un campo o el pin
 *                  (`moveAddressPin`), porque re-normalizar pisaría el único
 *                  dato bueno que hay.
 *   3. LEGACY    — una playa dada de alta ANTES de la migración
 *                  20260913164617: sólo tiene `address` como texto libre y
 *                  todas las columnas nuevas en NULL. La migración no hizo
 *                  backfill a propósito (parsear direcciones libres es
 *                  adivinar), así que este caso existe en la base de verdad y
 *                  hay que poder probarlo: el perfil de entidad tiene que
 *                  mostrarlo sin romperse y el alta de Mercado Pago tiene que
 *                  rechazarlo con un error entendible.
 *
 * El CHECK `tenants_coordinates_paired` sólo acepta las dos coordenadas o
 * ninguna: acá van siempre de a pares.
 */
type SeedTenantProfile = {
  id: string;
  /** Sólo para el `create` de contingencia; el alta normal es `seed.sql`. */
  name: string;
  legalName: string;
  cuit: string;
  email: string;
  phone: string;
  /** Plazas totales → `settings.capacity.total`. */
  capacityTotal: number;
  /** Línea de display: la `nomenclatura` de Georef, o el texto libre legacy. */
  address: string;
  streetName: string | null;
  streetNumber: string | null;
  floor: string | null;
  cityName: string | null;
  stateName: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  geocodingSource: 'georef' | 'manual' | null;
  geocodedAt: Date | null;
};

const CABA = 'Ciudad Autónoma de Buenos Aires';

/** Cuándo se cargó la dirección. Fijo: no es un dato que deba moverse solo. */
const GEOCODED_AT = new Date('2026-09-12T14:20:00.000Z');

const TENANT_PROFILES: SeedTenantProfile[] = [
  {
    // La playa piloto. Dirección tal cual la devolvió Georef para
    // "Bartolomé Mitre 2500": nomenclatura, calle en mayúsculas y el punto
    // interpolado sobre el segmento de calle.
    id: TENANTS.once,
    name: 'Estacionamiento Once',
    legalName: 'Estacionamientos Centro SA',
    cuit: '30711223343',
    email: 'once@parkit.test',
    phone: '+541149515151',
    capacityTotal: 55,
    address: `BARTOLOME MITRE 2500, Comuna 3, ${CABA}`,
    streetName: 'BARTOLOME MITRE',
    streetNumber: '2500',
    floor: null,
    cityName: CABA,
    stateName: CABA,
    postalCode: null,
    latitude: '-34.608621',
    longitude: '-58.401908',
    geocodingSource: 'georef',
    geocodedAt: GEOCODED_AT,
  },
  {
    // LEGACY a propósito: dada de alta antes de la migración de dirección
    // estructurada. `address` es texto libre escrito por una persona (con
    // acentos y abreviaturas, nada que ver con la nomenclatura de Georef) y
    // TODO lo estructurado en NULL. Mismo CUIT y misma razón social que Once:
    // `cuit` no es único porque una sociedad puede tener varias playas.
    id: TENANTS.belgrano,
    name: 'Estacionamiento Belgrano',
    legalName: 'Estacionamientos Centro SA',
    cuit: '30711223343',
    email: 'belgrano@parkit.test',
    phone: '+541147885050',
    capacityTotal: 33,
    address: 'Av. Cabildo 2000, CABA',
    streetName: null,
    streetNumber: null,
    floor: null,
    cityName: null,
    stateName: null,
    postalCode: null,
    latitude: null,
    longitude: null,
    geocodingSource: null,
    geocodedAt: null,
  },
  {
    // `manual`: Georef encontró "Av. Santa Fe 3800" (-34.584367, -58.417112) y
    // después el dueño agregó piso y código postal —que Georef no devuelve— y
    // movió el pin ~20 m hasta el portal. Cualquiera de esas tres acciones
    // marca el origen como `manual`.
    id: TENANTS.palermo,
    name: 'Estacionamiento Palermo',
    legalName: 'Cocheras Palermo SRL',
    cuit: '30709988774',
    email: 'palermo@parkit.test',
    phone: '+541148330606',
    capacityTotal: 40,
    address: `AV SANTA FE 3800, Comuna 14, ${CABA}`,
    streetName: 'AV SANTA FE',
    streetNumber: '3800',
    floor: 'PB',
    cityName: CABA,
    stateName: CABA,
    postalCode: 'C1425',
    latitude: '-34.584512',
    longitude: '-58.417034',
    geocodingSource: 'manual',
    geocodedAt: GEOCODED_AT,
  },
];

// ---------------------------------------------------------------------------
// Catálogo propio de cada estacionamiento
// ---------------------------------------------------------------------------

// Vehículos PROPIOS de cada estacionamiento. Los globales (244 modelos) los
// siembra el trigger `bootstrap_tenant_defaults()` al insertar el tenant, no un
// seed: `supabase/seed.sql` nunca llega a la nube y producción quedaría con el
// catálogo vacío.
type SeedVehicle = {
  seq: number;
  tenantId: string;
  brand: string;
  model: string;
  /** Nombre del tipo en `vehicle_types` de ESE tenant; se resuelve a `typeId`. */
  typeName: string;
  /** Sembrado ya borrado, para ejercitar el tombstone del sync. */
  deleted?: boolean;
};

/**
 * Tipo propio de demo. "Utilitario" NO está entre los siete defaults a
 * propósito: es el ejemplo canónico de la categoría que crea el dueño. Que Once
 * lo tenga hace que el seed DEMUESTRE la feature en vez de contradecirla — y le
 * da al Iveco Daily una clasificación honesta en vez de mandarlo a "Otro".
 */
const TENANT_VEHICLE_TYPES = [
  {
    seq: SEQ.vehicleType + 1,
    tenantId: TENANTS.once,
    name: 'Utilitario',
    accepted: true,
  },
];

const TENANT_VEHICLES: SeedVehicle[] = [
  {
    seq: SEQ.vehicle + 1,
    tenantId: TENANTS.once,
    brand: 'Iveco',
    model: 'Daily',
    typeName: 'Utilitario',
  },
  {
    seq: SEQ.vehicle + 2,
    tenantId: TENANTS.once,
    brand: 'Zanella',
    model: 'RX 150',
    typeName: 'Moto',
  },
  {
    seq: SEQ.vehicle + 3,
    tenantId: TENANTS.belgrano,
    brand: 'Agrale',
    model: 'Marruá',
    typeName: 'Pickup',
  },
  {
    // Tombstone a propósito: ejercita que una baja llegue a los clientes
    // offline por /vehicles/changes. Mismo criterio que las tarifas borradas.
    seq: SEQ.vehicle + 4,
    tenantId: TENANTS.once,
    brand: 'Corven',
    model: 'Energy',
    typeName: 'Moto',
    deleted: true,
  },
  {
    // Ojo al elegir marca/modelo: el catálogo que siembra el trigger ya trae
    // 244 modelos y el índice único (tenant, marca, modelo) es
    // case-insensitive sobre los vivos. Un "Peugeot 208" acá no es un vehículo
    // propio: es un choque contra el catálogo. Las cuatro marcas de arriba y
    // esta están elegidas justamente porque NO están en `vehicle_catalog_defaults`.
    seq: SEQ.vehicle + 5,
    tenantId: TENANTS.palermo,
    brand: 'Gilera',
    model: 'Smash 110',
    typeName: 'Moto',
  },
];

// ---------------------------------------------------------------------------
// Tarifas
// ---------------------------------------------------------------------------

/**
 * Tarifas en órdenes de magnitud plausibles para una playa de CABA hoy.
 *
 * Los tres precios NO son independientes: el cobro sugerido es
 * `min(horas * hora + (sobra fracción ? fracción : 0), estadía)`
 * (`calcSuggestedAmount`, entries.service.ts). O sea que `stayPrice` es el
 * TECHO del día y `fractionPrice` es la media hora. Los valores viejos
 * (hora 4444.44, fracción 300, estadía 8000) se contradecían entre sí: la
 * fracción salía el 7% de la hora y el techo se alcanzaba a las dos horas, con
 * lo cual la tarifa por hora casi no se usaba nunca.
 *
 * Un precio con centavos a propósito (`AUTO NOCHE`): ejercita el formateo en
 * pesos y la precisión `Decimal(12,2)`, donde los números redondos tapan bugs.
 */
type SeedRate = {
  key: string;
  seq: number;
  tenantId: string;
  name: string;
  hourPriceArs: string;
  stayPriceArs: string;
  fractionPriceArs: string;
  shortcutNumber: number;
  isActive?: boolean;
  /** Tarifa borrada (tombstone) — ver abajo. */
  deleted?: boolean;
};

const RATES: SeedRate[] = [
  {
    key: 'once-auto',
    seq: SEQ.rate + 1,
    tenantId: TENANTS.once,
    name: 'AUTO POR HORA',
    hourPriceArs: '4500.00',
    stayPriceArs: '21000.00',
    fractionPriceArs: '2700.00',
    shortcutNumber: 1,
  },
  {
    key: 'once-moto',
    seq: SEQ.rate + 2,
    tenantId: TENANTS.once,
    name: 'MOTO POR HORA',
    hourPriceArs: '2400.00',
    stayPriceArs: '11000.00',
    fractionPriceArs: '1500.00',
    shortcutNumber: 2,
  },
  // Desactivada, NO borrada: el panel del dueño la sigue listando y la puede
  // reactivar. Mantiene visible la distinción isActive/deletedAt en un entorno
  // recién sembrado.
  {
    key: 'once-noche',
    seq: SEQ.rate + 3,
    tenantId: TENANTS.once,
    name: 'AUTO NOCHE (20 A 8)',
    hourPriceArs: '3900.50',
    stayPriceArs: '15800.00',
    fractionPriceArs: '2350.75',
    shortcutNumber: 3,
    isActive: false,
  },
  // Borrada lógicamente: nunca la devuelve GET /rates, pero sí viaja por
  // GET /rates/changes como tombstone. Su número de atajo queda reutilizable
  // porque el índice único es parcial sobre `deleted_at IS NULL`.
  {
    key: 'once-vieja',
    seq: SEQ.rate + 4,
    tenantId: TENANTS.once,
    name: 'TARIFA VIEJA (DEMO BORRADA)',
    hourPriceArs: '2900.00',
    stayPriceArs: '9500.00',
    fractionPriceArs: '1800.00',
    shortcutNumber: 9,
    deleted: true,
  },
  {
    key: 'belgrano-auto',
    seq: SEQ.rate + 5,
    tenantId: TENANTS.belgrano,
    name: 'AUTO POR HORA',
    hourPriceArs: '4200.00',
    stayPriceArs: '19500.00',
    fractionPriceArs: '2500.00',
    shortcutNumber: 1,
  },
  {
    key: 'palermo-auto',
    seq: SEQ.rate + 6,
    tenantId: TENANTS.palermo,
    name: 'AUTO POR HORA',
    hourPriceArs: '5200.00',
    stayPriceArs: '24000.00',
    fractionPriceArs: '3100.00',
    shortcutNumber: 1,
  },
  {
    key: 'palermo-moto',
    seq: SEQ.rate + 7,
    tenantId: TENANTS.palermo,
    name: 'MOTO POR HORA',
    hourPriceArs: '2800.00',
    stayPriceArs: '12500.00',
    fractionPriceArs: '1700.00',
    shortcutNumber: 2,
  },
];

const RATES_BY_KEY = new Map(RATES.map((r) => [r.key, r]));

// ---------------------------------------------------------------------------
// Horarios
// ---------------------------------------------------------------------------

/**
 * Horarios de atención. `open_minute`/`close_minute` son minutos desde
 * medianoche; los CHECK exigen `0 <= open < 1440`, `0 < close <= 1440` y
 * `close > open`.
 *
 * Once abre los sábados "por partes" (dos rangos del mismo día), que es el
 * caso que justifica que la tabla tenga varias filas por día y el único que
 * ejercita la validación de solapamiento de `SchedulesService`.
 */
type SeedSchedule = {
  tenantId: string;
  day: ScheduleDay;
  openMinute: number;
  closeMinute: number;
};

const WEEKDAYS: ScheduleDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
];

const SCHEDULES: SeedSchedule[] = [
  ...WEEKDAYS.map((day) => ({
    tenantId: TENANTS.once,
    day,
    openMinute: 7 * 60,
    closeMinute: 22 * 60,
  })),
  {
    tenantId: TENANTS.once,
    day: 'saturday',
    openMinute: 8 * 60,
    closeMinute: 13 * 60,
  },
  {
    tenantId: TENANTS.once,
    day: 'saturday',
    openMinute: 17 * 60,
    closeMinute: 21 * 60,
  },
  ...WEEKDAYS.map((day) => ({
    tenantId: TENANTS.belgrano,
    day,
    openMinute: 8 * 60,
    closeMinute: 20 * 60,
  })),
  // Palermo abre las 24 h de lunes a domingo: `closeMinute` 1440 es el tope que
  // acepta el CHECK y representa la medianoche del día siguiente.
  ...([...WEEKDAYS, 'saturday', 'sunday'] as ScheduleDay[]).map((day) => ({
    tenantId: TENANTS.palermo,
    day,
    openMinute: 0,
    closeMinute: 1440,
  })),
];

// ---------------------------------------------------------------------------
// Abonados (whitelist)
// ---------------------------------------------------------------------------

/**
 * Un abonado mensual. Existe para que el camino LPR tenga sentido: cuando la
 * cámara lee esta patente, `createLprEntry` encuentra la autorización vigente
 * y deja `entries.whitelist_id` apuntando acá. Sin ninguna fila, esa rama del
 * código no se ejecuta nunca en local.
 */
const WHITELIST = [
  {
    tenantId: TENANTS.once,
    plate: 'AE773LP',
    validFrom: at(-10, 0),
    validUntil: at(20, 23, 59),
    notes: 'Abonado mensual — cochera fija A-03.',
  },
];

// ---------------------------------------------------------------------------
// Cajas
// ---------------------------------------------------------------------------

/**
 * Dos cajas encadenadas, como las produce `closeSession()`: al cerrar una, el
 * backend abre la siguiente con `openedAt = closedAt` y
 * `openingCash = leavingCash`. La cadena no se corta nunca, así que un fixture
 * con una caja cerrada y otra abierta "sueltas" sería imposible.
 */
type SeedCashSession = {
  key: string;
  seq: number;
  tenantId: string;
  openedAt: Date;
  closedAt: Date | null;
  openingCashArs: string;
  leavingCashArs: string | null;
  notes?: string;
};

const CASH_SESSIONS: SeedCashSession[] = [
  {
    key: 'once-ayer',
    seq: SEQ.cashSession + 1,
    tenantId: TENANTS.once,
    openedAt: at(-1, 8, 0),
    closedAt: at(-1, 20, 30),
    openingCashArs: '30000.00',
    // 30.000 de apertura + 33.000 cobrados en efectivo (11.700 + 15.000 +
    // 6.300). Los 6.000 por transferencia NO suman al arqueo de caja, que es
    // justo lo que el cierre tiene que demostrar.
    leavingCashArs: '63000.00',
    notes: 'Cierre del turno tarde. Arqueo sin diferencias.',
  },
  {
    key: 'once-hoy',
    seq: SEQ.cashSession + 2,
    tenantId: TENANTS.once,
    openedAt: at(-1, 20, 30),
    closedAt: null,
    openingCashArs: '63000.00',
    leavingCashArs: null,
  },
];

// ---------------------------------------------------------------------------
// Ingresos y cobros
// ---------------------------------------------------------------------------

/**
 * A qué método de pago apunta un cobro. El NOMBRE no se escribe acá: se copia
 * de la fila real de `payment_methods` al sembrar, igual que hace el desktop al
 * cobrar (`paymentMethodName: pm.name`).
 *
 * Es la parte que más importa de todo este archivo:
 * `payment_transactions.payment_method_name` es un SNAPSHOT, y el arqueo de
 * caja decide qué cobro es efectivo mirando ESE texto
 * (`isCashMethod(name) = name.toLowerCase().includes('efectivo')`), no el
 * `type`. Un snapshot en inglés hace que el efectivo desaparezca del arqueo.
 */
type SeedPaymentMethodRef =
  | { system: Extract<PaymentMethodType, 'cash' | 'transfer'> }
  | { custom: string };

type SeedPayment = {
  seq: number;
  method: SeedPaymentMethodRef;
  amountArs: string;
};

type SeedEntry = {
  seq: number;
  tenantId: string;
  plate: string;
  vehicleBrand?: string;
  vehicleModel?: string;
  color?: string;
  cochera?: string;
  notes?: string;
  enteredAt: Date;
  leftAt?: Date;
  amountPaidArs?: string;
  /** Clave en RATES: aporta `rateId` + los cuatro campos de snapshot. */
  rateKey?: string;
  cashSessionKey?: string;
  ticketNumber?: number;
  payments?: SeedPayment[];
  /** Ingreso automático por cámara. Ver `LPR_ENTRY_ID`. */
  lpr?: {
    id: string;
    vehicleType: string;
    cameraId: string;
    whitelistPlate?: string;
  };
};

/**
 * El ingreso por LPR es el ÚNICO cuyo id NO es v7: lo genera el servidor con
 * `crypto.randomUUID()` (v4) porque la cámara no manda id
 * (`createLprEntry`, entries.service.ts). Replicarlo v4 no es un descuido: es
 * exactamente lo que produce la aplicación.
 */
const LPR_ENTRY_ID = '7c1f1f4e-26b1-4a6a-9a1d-2f8f0f9a1b31';

/**
 * Patentes con los DOS formatos argentinos que conviven en la calle:
 *   - viejo `AAA000` (hasta 2016): RKL482, SVT915, MQR318
 *   - Mercosur `AA000AA` (autos): AF412XZ, AD836MK, AB512CD, AG456HI, AH902KT,
 *     AE773LP
 *   - Mercosur `A000AAA` (motos): A054HRT
 *
 * Importa más de lo que parece: el buscador por patente, la detección de
 * estadía duplicada y el matcheo del LPR trabajan sobre este texto.
 */
const ENTRIES: SeedEntry[] = [
  // --- Once, caja de AYER (cerrada). Tickets 1..3 -------------------------
  {
    seq: SEQ.entry + 1,
    tenantId: TENANTS.once,
    plate: 'AF412XZ',
    vehicleBrand: 'Toyota',
    vehicleModel: 'Corolla',
    color: 'Negro',
    enteredAt: at(-1, 8, 40),
    leftAt: at(-1, 11, 15),
    // 2 h 35 → 2 × 4500 + 2700 = 11.700 (techo 21.000, no se alcanza).
    amountPaidArs: '11700.00',
    rateKey: 'once-auto',
    cashSessionKey: 'once-ayer',
    ticketNumber: 1,
    payments: [
      {
        seq: SEQ.payment + 1,
        method: { system: 'cash' },
        amountArs: '11700.00',
      },
    ],
  },
  {
    seq: SEQ.entry + 2,
    tenantId: TENANTS.once,
    plate: 'RKL482',
    vehicleBrand: 'Renault',
    vehicleModel: 'Kangoo',
    color: 'Blanco',
    cochera: 'A-07',
    enteredAt: at(-1, 9, 5),
    leftAt: at(-1, 19, 50),
    // 10 h 45 → 10 × 4500 + 2700 = 47.700, TOPEADO por la estadía: 21.000.
    // Es el caso que justifica que `stayPrice` sea un techo y no un precio más.
    amountPaidArs: '21000.00',
    rateKey: 'once-auto',
    cashSessionKey: 'once-ayer',
    ticketNumber: 2,
    // Cobro partido en dos métodos: el desktop lo permite y el arqueo tiene que
    // contar sólo los 15.000 de efectivo.
    payments: [
      {
        seq: SEQ.payment + 2,
        method: { system: 'cash' },
        amountArs: '15000.00',
      },
      {
        seq: SEQ.payment + 3,
        method: { system: 'transfer' },
        amountArs: '6000.00',
      },
    ],
  },
  {
    seq: SEQ.entry + 3,
    tenantId: TENANTS.once,
    plate: 'A054HRT',
    vehicleBrand: 'Zanella',
    vehicleModel: 'RX 150',
    color: 'Rojo',
    enteredAt: at(-1, 14, 0),
    leftAt: at(-1, 16, 30),
    // 2 h 30 con tarifa de moto → 2 × 2400 + 1500 = 6.300.
    amountPaidArs: '6300.00',
    rateKey: 'once-moto',
    cashSessionKey: 'once-ayer',
    ticketNumber: 3,
    payments: [
      {
        seq: SEQ.payment + 4,
        method: { system: 'cash' },
        amountArs: '6300.00',
      },
    ],
  },

  // --- Once, caja de HOY (abierta). Tickets 1..3 --------------------------
  {
    seq: SEQ.entry + 4,
    tenantId: TENANTS.once,
    plate: 'AB512CD',
    vehicleBrand: 'Fiat',
    vehicleModel: 'Cronos',
    color: 'Azul',
    enteredAt: at(0, 7, 30),
    leftAt: at(0, 10, 5),
    amountPaidArs: '11700.00',
    rateKey: 'once-auto',
    cashSessionKey: 'once-hoy',
    ticketNumber: 1,
    // Cobrado con un método PROPIO del dueño (type `other`, no `is_system`):
    // el arqueo lo tiene que contar como "otros medios", no como efectivo.
    payments: [
      {
        seq: SEQ.payment + 5,
        method: { custom: 'Tarjeta de débito' },
        amountArs: '11700.00',
      },
    ],
  },
  {
    seq: SEQ.entry + 5,
    tenantId: TENANTS.once,
    plate: 'AD836MK',
    vehicleBrand: 'Volkswagen',
    vehicleModel: 'Amarok',
    color: 'Gris',
    enteredAt: at(0, 8, 20),
    rateKey: 'once-auto',
    cashSessionKey: 'once-hoy',
    ticketNumber: 2,
  },
  {
    seq: SEQ.entry + 6,
    tenantId: TENANTS.once,
    plate: 'SVT915',
    vehicleBrand: 'Ford',
    vehicleModel: 'Ranger',
    color: 'Blanco',
    cochera: 'B-12',
    notes: 'Retira después de las 20. Avisar al 11-5555-0000.',
    enteredAt: at(0, 9, 45),
    rateKey: 'once-auto',
    cashSessionKey: 'once-hoy',
    ticketNumber: 3,
  },
  {
    // Ingreso AUTOMÁTICO por cámara: `source='auto'`, con el tipo de vehículo
    // snapshoteado (el alta manual no lo manda: `CreateEntryDto` ni siquiera
    // tiene el campo) y enganchado al abonado por patente. Sin tarifa ni
    // ticket: el camino LPR no elige tarifa ni numera, eso pasa al cobrar.
    seq: SEQ.entry + 7,
    tenantId: TENANTS.once,
    plate: 'AE773LP',
    enteredAt: at(0, 7, 5),
    lpr: {
      id: LPR_ENTRY_ID,
      vehicleType: 'Auto',
      cameraId: 'CAM-INGRESO-1',
      whitelistPlate: 'AE773LP',
    },
  },

  // --- Belgrano (sin caja: la playa legacy cobra a mano) ------------------
  {
    // Cierre SIN desglose de cobros: `amountPaid` directo, que es el fallback
    // legacy/offline que `CloseEntryDto` documenta y sigue aceptando. Un solo
    // caso a propósito — el resto tiene sus transacciones, porque un cobro sin
    // transacción es lo que rompe el arqueo.
    seq: SEQ.entry + 8,
    tenantId: TENANTS.belgrano,
    plate: 'MQR318',
    vehicleBrand: 'Renault',
    vehicleModel: 'Kangoo',
    color: 'Rojo',
    enteredAt: at(-1, 9, 20),
    leftAt: at(-1, 11, 0),
    // 1 h 40 → 4200 + 2500 = 6.700.
    amountPaidArs: '6700.00',
    rateKey: 'belgrano-auto',
  },
  {
    seq: SEQ.entry + 9,
    tenantId: TENANTS.belgrano,
    plate: 'AG456HI',
    vehicleBrand: 'Toyota',
    vehicleModel: 'Corolla',
    color: 'Negro',
    enteredAt: at(0, 10, 30),
    rateKey: 'belgrano-auto',
  },

  // --- Palermo -----------------------------------------------------------
  {
    seq: SEQ.entry + 10,
    tenantId: TENANTS.palermo,
    plate: 'AH902KT',
    vehicleBrand: 'Peugeot',
    vehicleModel: '208',
    color: 'Blanco',
    enteredAt: at(0, 9, 10),
    rateKey: 'palermo-auto',
  },
];

/**
 * Métodos de pago PROPIOS del dueño (`type='other'`, `is_system=false`): los
 * que puede crear y borrar libremente. El id lo genera la base
 * (`gen_random_uuid()`), así que la idempotencia va por (tenant, nombre) y no
 * por un id inventado.
 */
const CUSTOM_PAYMENT_METHODS = [
  { tenantId: TENANTS.once, name: 'Tarjeta de débito' },
];

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const APPLICATIONS = {
  pending: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  draft: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  rejected: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
} as const;

const PENDING_DOCUMENT = 'dddddddd-dddd-4ddd-8ddd-ddddddddddc1';

// ---------------------------------------------------------------------------
// Limpieza de los ids del seed VIEJO
// ---------------------------------------------------------------------------

/**
 * El seed viejo usaba ids v4 decorativos. Al pasar a UUIDv7 (que es lo que
 * genera el cliente) esas filas quedarían HUÉRFANAS en cualquier base que ya
 * se hubiera sembrado: duplicadas con las nuevas y, peor, chocando contra los
 * índices únicos parciales — el número de atajo de una tarifa y el par
 * marca/modelo de un vehículo son únicos por estacionamiento mientras
 * `deleted_at IS NULL`.
 *
 * Por eso se borran ANTES de sembrar, y por eso este bloque existe aunque sea
 * feo: sin él, `bun run seed:tenant` sobre una base vieja revienta con P2002.
 *
 * Se puede eliminar cuando todos los entornos locales hayan corrido el seed
 * nuevo al menos una vez.
 */
const LEGACY_SEED_IDS = {
  entries: [
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
  ],
  rates: [
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'ffffffff-ffff-4fff-8fff-fffffffffff2',
    'ffffffff-ffff-4fff-8fff-fffffffffff3',
    'ffffffff-ffff-4fff-8fff-fffffffffff4',
  ],
  vehicles: [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabb1',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabb2',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabb3',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabb4',
  ],
  vehicleTypes: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaacc1'],
} as const;

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

/** Fijo para que re-sembrar escriba el mismo valor y no un timestamp móvil. */
const DEMO_DELETED_AT = new Date('2026-05-04T18:00:00.000Z');

async function dropLegacySeedRows(): Promise<void> {
  // `payment_transactions` cae sola: su FK a `entries` es ON DELETE CASCADE.
  // `entries.rate_id` es ON DELETE SET NULL, así que borrar una tarifa vieja no
  // rompe ingresos históricos — se quedan con el snapshot de la tarifa, que es
  // exactamente para lo que existe.
  const entries = await prisma.entry.deleteMany({
    where: { id: { in: [...LEGACY_SEED_IDS.entries] } },
  });
  const rates = await prisma.rate.deleteMany({
    where: { id: { in: [...LEGACY_SEED_IDS.rates] } },
  });
  const vehicles = await prisma.vehicle.deleteMany({
    where: { id: { in: [...LEGACY_SEED_IDS.vehicles] } },
  });

  let types = 0;
  try {
    const deleted = await prisma.vehicleType.deleteMany({
      where: { id: { in: [...LEGACY_SEED_IDS.vehicleTypes] } },
    });
    types = deleted.count;
  } catch {
    // La FK compuesta desde `vehicles` es ON DELETE RESTRICT: si alguien cargó
    // un vehículo a mano con este tipo, se avisa y se sigue.
    console.warn(
      '⚠ No se pudo borrar el tipo de vehículo legacy: todavía tiene vehículos asociados.',
    );
  }

  const total = entries.count + rates.count + vehicles.count + types;
  if (total > 0) {
    console.log(
      `✓ Limpieza del seed viejo: ${total} filas con ids v4 dadas de baja (${entries.count} ingresos, ${rates.count} tarifas, ${vehicles.count} vehículos, ${types} tipos).`,
    );
  }
}

/**
 * Perfil de la entidad: datos legales, de contacto, capacidad y DIRECCIÓN.
 *
 * `settings` se arma con `withCapacity()` sobre lo que ya había y NO con el
 * literal `{ capacity }`: el literal PISA el objeto entero. Hoy `capacity` es
 * la única clave, pero el día que haya una segunda este camino la borraría en
 * silencio — que es justo el modo de falla por el que la dirección fue a
 * columnas planas y no a `settings`. Mismo helper que usa `updateProfile` y
 * que `applications.approve()`.
 */
async function seedTenantProfiles(): Promise<void> {
  const t = tally();

  for (const profile of TENANT_PROFILES) {
    const {
      id,
      name,
      capacityTotal,
      legalName,
      cuit,
      email,
      phone,
      ...address
    } = profile;

    const existing = await prisma.tenant.findUnique({ where: { id } });
    if (!existing) {
      // El alta normal la hace `supabase/seed.sql` (corre antes que este
      // script, porque `seed-auth` necesita el tenant para las membresías).
      // Crearlo acá es la red de contención de `bun run seed:tenant` suelto:
      // el trigger `bootstrap_tenant_defaults()` siembra tipos, catálogo,
      // servicios y métodos de pago igual que en cualquier alta real.
      await prisma.tenant.create({
        data: {
          id,
          name,
          legalName,
          cuit,
          email,
          phone,
          status: 'active',
          settings: withCapacity({}, { total: capacityTotal }),
          ...address,
        },
      });
      console.warn(
        `⚠ El estacionamiento "${name}" no existía y se creó acá. Corré \`make seed-global\` y \`make seed-auth\` para que tenga membresías.`,
      );
      t.created += 1;
      continue;
    }

    const fields = {
      legalName,
      cuit,
      email,
      phone,
      status: 'active' as const,
      ...address,
    };
    const settings = withCapacity(existing.settings, { total: capacityTotal });
    const capacityChanged = !sameValue(
      JSON.stringify(existing.settings),
      JSON.stringify(settings),
    );

    if (needsUpdate(existing, fields) || capacityChanged) {
      await prisma.tenant.update({
        where: { id },
        data: { ...fields, settings },
      });
      t.updated += 1;
    } else {
      t.unchanged += 1;
    }
  }

  console.log(describe(`Perfiles de ${TENANT_PROFILES.length} entidades`, t));
}

/**
 * Vehículos propios de cada estacionamiento (idempotente, ids fijos).
 *
 * `syncSeq` nunca se pasa: la columna tiene DEFAULT nextval('vehicles_sync_seq')
 * y un valor explícito caería en 0, invisible para /vehicles/changes.
 */
async function seedTenantVehicles(): Promise<void> {
  const t = tally();

  // El tipo propio de demo va primero: los vehículos lo referencian por FK.
  for (const type of TENANT_VEHICLE_TYPES) {
    const id = seedUuidV7(type.seq);
    const fields = { name: type.name, accepted: type.accepted };
    const existing = await prisma.vehicleType.findUnique({ where: { id } });
    if (!existing) {
      await prisma.vehicleType.create({
        data: { id, tenantId: type.tenantId, ...fields },
      });
    } else if (needsUpdate(existing, fields)) {
      await prisma.vehicleType.update({ where: { id }, data: fields });
    }
  }

  for (const vehicle of TENANT_VEHICLES) {
    // Los siete tipos por defecto los siembra el trigger de `tenants`; acá se
    // resuelve el nombre al id de ESE estacionamiento.
    const type = await prisma.vehicleType.findFirst({
      where: {
        tenantId: vehicle.tenantId,
        name: vehicle.typeName,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!type) {
      console.warn(
        `⚠ Skipped vehicle "${vehicle.brand} ${vehicle.model}": no existe el tipo "${vehicle.typeName}" en ese estacionamiento.`,
      );
      continue;
    }

    const id = seedUuidV7(vehicle.seq);
    const fields = {
      tenantId: vehicle.tenantId,
      brand: vehicle.brand,
      model: vehicle.model,
      typeId: type.id,
      deletedAt: vehicle.deleted ? DEMO_DELETED_AT : null,
    };

    try {
      const existing = await prisma.vehicle.findUnique({ where: { id } });
      if (!existing) {
        await prisma.vehicle.create({ data: { id, ...fields } });
        t.created += 1;
      } else if (needsUpdate(existing, fields)) {
        await prisma.vehicle.update({ where: { id }, data: fields });
        t.updated += 1;
      } else {
        t.unchanged += 1;
      }
    } catch (error) {
      // `vehicles_tenant_brand_model_uidx` es parcial sobre `deleted_at IS NULL`,
      // así que una fila viva cargada a mano con la misma marca/modelo colisiona.
      // Se saltea con un mensaje claro en vez de voltear todo `make seed-all`.
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      console.warn(
        `⚠ Skipped vehicle "${vehicle.brand} ${vehicle.model}": already taken in this tenant.`,
      );
    }
  }

  const tombstones = TENANT_VEHICLES.filter((v) => v.deleted).length;
  console.log(
    describe(
      `Vehículos propios (${tombstones} con baja lógica, para el sync de tombstones)`,
      t,
    ),
  );
}

/**
 * Tarifas (idempotente, ids fijos).
 *
 * `syncSeq` nunca se pasa: la columna defaultea a `nextval('rates_sync_seq')` y
 * un valor explícito caería en 0, invisible para `/rates/changes` (eso es lo
 * que tuvo que reparar 20260604024720_fix_sync_seq_zero.sql).
 */
async function seedRates(): Promise<void> {
  const t = tally();

  for (const rate of RATES) {
    const id = seedUuidV7(rate.seq);
    const fields = {
      tenantId: rate.tenantId,
      name: rate.name,
      hourPriceArs: rate.hourPriceArs,
      stayPriceArs: rate.stayPriceArs,
      fractionPriceArs: rate.fractionPriceArs,
      shortcutNumber: rate.shortcutNumber,
      isActive: rate.isActive ?? true,
      deletedAt: rate.deleted ? DEMO_DELETED_AT : null,
    };

    try {
      const existing = await prisma.rate.findUnique({ where: { id } });
      if (!existing) {
        await prisma.rate.create({ data: { id, ...fields } });
        t.created += 1;
      } else if (needsUpdate(existing, fields)) {
        await prisma.rate.update({ where: { id }, data: fields });
        t.updated += 1;
      } else {
        t.unchanged += 1;
      }
    } catch (error) {
      // El índice único parcial sobre (tenant_id, shortcut_number) está acotado
      // a `deleted_at IS NULL`, así que una tarifa viva cargada a mano con el
      // mismo atajo colisiona. Se saltea con un mensaje claro.
      const code = (error as { code?: string }).code;
      if (code !== 'P2002') throw error;
      console.warn(
        `⚠ Skipped rate "${rate.name}": shortcut ${rate.shortcutNumber} is already taken in this tenant by another rate.`,
      );
    }
  }

  const tombstones = RATES.filter((r) => r.deleted).length;
  console.log(describe(`Tarifas (${tombstones} borrada lógicamente)`, t));
}

/**
 * Horarios.
 *
 * El id lo genera la base y un día puede tener varios rangos, así que la clave
 * de idempotencia es (tenant, día, hora de apertura). NO se hace
 * "borrar todo y volver a insertar": eso le cambiaría el id y el `sync_seq` a
 * cada fila en cada corrida, y los clientes offline se bajarían la tabla
 * entera de nuevo como si fuera contenido nuevo.
 */
async function seedSchedules(): Promise<void> {
  const t = tally();
  const tenantIds = [...new Set(SCHEDULES.map((s) => s.tenantId))];
  const keep: string[] = [];

  for (const schedule of SCHEDULES) {
    const existing = await prisma.schedule.findFirst({
      where: {
        tenantId: schedule.tenantId,
        day: schedule.day,
        openMinute: schedule.openMinute,
      },
    });
    if (!existing) {
      const created = await prisma.schedule.create({ data: schedule });
      keep.push(created.id);
      t.created += 1;
    } else {
      keep.push(existing.id);
      if (existing.closeMinute !== schedule.closeMinute) {
        await prisma.schedule.update({
          where: { id: existing.id },
          data: { closeMinute: schedule.closeMinute },
        });
        t.updated += 1;
      } else {
        t.unchanged += 1;
      }
    }
  }

  // Rangos viejos del seed que ya no están en el fixture, acotado a los
  // estacionamientos que este script administra.
  await prisma.schedule.deleteMany({
    where: { tenantId: { in: tenantIds }, id: { notIn: keep } },
  });

  console.log(describe(`Horarios (${SCHEDULES.length} rangos)`, t));
}

/**
 * Abonados. Clave de idempotencia: (tenant, patente).
 *
 * Acá "borrar y reinsertar" era peor que un id que cambia: el ingreso por LPR
 * guarda `entries.whitelist_id`, así que recrear la fila le dejaba al ingreso
 * un id distinto en cada corrida (o un `NULL`, porque la FK es ON DELETE SET
 * NULL). Re-sembrar no puede cambiar a qué abonado apunta una estadía.
 */
async function seedWhitelist(): Promise<void> {
  const t = tally();

  for (const authorized of WHITELIST) {
    const { tenantId, plate, ...fields } = authorized;
    const existing = await prisma.whitelist.findFirst({
      where: { tenantId, plate },
    });
    if (!existing) {
      await prisma.whitelist.create({ data: authorized });
      t.created += 1;
    } else if (needsUpdate(existing, fields)) {
      await prisma.whitelist.update({
        where: { id: existing.id },
        data: fields,
      });
      t.updated += 1;
    } else {
      t.unchanged += 1;
    }
  }

  console.log(describe('Abonados (whitelist)', t));
}

/**
 * Id real de cada caja del fixture. Casi siempre es `seedUuidV7(seq)`, pero
 * puede ser el de una caja ajena ya abierta — ver `seedCashSessions`.
 */
const cashSessionIdByKey = new Map<string, string>();

async function seedCashSessions(): Promise<void> {
  const t = tally();

  for (const session of CASH_SESSIONS) {
    const id = seedUuidV7(session.seq);
    const fields = {
      tenantId: session.tenantId,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingCash: session.openingCashArs,
      leavingCash: session.leavingCashArs,
      notes: session.notes ?? null,
    };

    const existing = await prisma.cashSession.findUnique({ where: { id } });

    // UNA sola caja abierta por estacionamiento: `cash_sessions_tenant_open_idx`
    // es un índice único PARCIAL sobre (tenant_id) WHERE closed_at IS NULL, y
    // `createSession()` lo respeta rechazando la segunda apertura. Si en la base
    // ya quedó una caja abierta que no es la del fixture (una prueba a mano, un
    // turno sin cerrar), crear la nuestra sería imposible: no se le pisa el
    // turno a nadie, se ADOPTA la que está abierta y los ingresos de hoy se
    // cuelgan de esa. Sin esto el seed moría con un P2002 críptico.
    if (!existing && session.closedAt === null) {
      const alreadyOpen = await prisma.cashSession.findFirst({
        where: { tenantId: session.tenantId, closedAt: null },
        select: { id: true },
      });
      if (alreadyOpen) {
        cashSessionIdByKey.set(session.key, alreadyOpen.id);
        console.warn(
          `⚠ Ya había una caja abierta en ese estacionamiento: se usa esa (${alreadyOpen.id}) en vez de abrir otra.`,
        );
        t.unchanged += 1;
        continue;
      }
    }

    cashSessionIdByKey.set(session.key, id);

    if (!existing) {
      await prisma.cashSession.create({ data: { id, ...fields } });
      t.created += 1;
    } else if (needsUpdate(existing, fields)) {
      await prisma.cashSession.update({ where: { id }, data: fields });
      t.updated += 1;
    } else {
      t.unchanged += 1;
    }
  }

  console.log(describe('Cajas (una cerrada y su continuación abierta)', t));
}

/**
 * Métodos de pago propios del dueño (`type='other'`). Se identifican por
 * (tenant, nombre) porque el id lo pone la base, igual que en el alta real.
 */
async function seedCustomPaymentMethods(): Promise<void> {
  for (const method of CUSTOM_PAYMENT_METHODS) {
    const existing = await prisma.paymentMethod.findFirst({
      where: { tenantId: method.tenantId, name: method.name },
    });
    if (existing) continue;
    await prisma.paymentMethod.create({
      data: {
        tenantId: method.tenantId,
        type: 'other',
        name: method.name,
        enabled: true,
        isSystem: false,
        isDefault: false,
      },
    });
  }
}

/** Resuelve un cobro del fixture a la fila real de `payment_methods`. */
async function resolvePaymentMethod(
  tenantId: string,
  ref: SeedPaymentMethodRef,
): Promise<{ id: string; name: string } | null> {
  const where =
    'system' in ref
      ? { tenantId, type: ref.system, isSystem: true }
      : { tenantId, name: ref.custom };
  return prisma.paymentMethod.findFirst({
    where,
    select: { id: true, name: true },
  });
}

async function seedEntries(): Promise<void> {
  const entriesTally = tally();
  const paymentsTally = tally();

  for (const entry of ENTRIES) {
    const id = entry.lpr ? entry.lpr.id : seedUuidV7(entry.seq);
    const rate = entry.rateKey ? RATES_BY_KEY.get(entry.rateKey) : undefined;
    const cashSessionId = entry.cashSessionKey
      ? (cashSessionIdByKey.get(entry.cashSessionKey) ?? null)
      : null;

    let whitelistId: string | null = null;
    if (entry.lpr?.whitelistPlate) {
      const authorized = await prisma.whitelist.findFirst({
        where: { tenantId: entry.tenantId, plate: entry.lpr.whitelistPlate },
        select: { id: true },
      });
      whitelistId = authorized?.id ?? null;
    }

    const fields = {
      tenantId: entry.tenantId,
      plate: entry.plate,
      color: entry.color ?? null,
      cochera: entry.cochera ?? null,
      notes: entry.notes ?? null,
      enteredAt: entry.enteredAt,
      leftAt: entry.leftAt ?? null,
      amountPaid: entry.amountPaidArs ?? null,
      vehicleBrand: entry.vehicleBrand ?? null,
      vehicleModel: entry.vehicleModel ?? null,
      // Snapshot de tarifa: lo captura el alta y ya no se toca. El seed viejo
      // lo dejaba en NULL, con lo cual `calcSuggestedAmount` daba 0 y el cobro
      // del desktop arrancaba sin nada que sugerir.
      rateId: rate ? seedUuidV7(rate.seq) : null,
      rateSnapshotName: rate?.name ?? null,
      rateSnapshotHourPriceArs: rate?.hourPriceArs ?? null,
      rateSnapshotStayPriceArs: rate?.stayPriceArs ?? null,
      rateSnapshotFractionPriceArs: rate?.fractionPriceArs ?? null,
      cashSessionId,
      ticketNumber: entry.ticketNumber ?? null,
      source: entry.lpr ? 'auto' : 'manual',
      vehicleType: entry.lpr?.vehicleType ?? null,
      entryCameraId: entry.lpr?.cameraId ?? null,
      whitelistId,
    };

    const existing = await prisma.entry.findUnique({ where: { id } });
    if (!existing) {
      await prisma.entry.create({ data: { id, ...fields } });
      entriesTally.created += 1;
    } else if (needsUpdate(existing, fields)) {
      await prisma.entry.update({ where: { id }, data: fields });
      entriesTally.updated += 1;
    } else {
      entriesTally.unchanged += 1;
    }

    for (const payment of entry.payments ?? []) {
      const method = await resolvePaymentMethod(entry.tenantId, payment.method);
      if (!method) {
        console.warn(
          `⚠ Cobro salteado en ${entry.plate}: no se encontró el método de pago.`,
        );
        continue;
      }

      const paymentId = seedUuidV7(payment.seq);
      const paymentFields = {
        tenantId: entry.tenantId,
        entryId: id,
        cashSessionId: fields.cashSessionId,
        paymentMethodId: method.id,
        // El nombre se COPIA de la fila, igual que el desktop al cobrar. Si el
        // dueño renombró el método, el snapshot guarda el nombre de ese
        // momento — que es exactamente lo que la columna significa.
        paymentMethodName: method.name,
        amount: payment.amountArs,
      };

      const existingPayment = await prisma.paymentTransaction.findUnique({
        where: { id: paymentId },
      });
      if (!existingPayment) {
        await prisma.paymentTransaction.create({
          data: { id: paymentId, ...paymentFields },
        });
        paymentsTally.created += 1;
      } else if (needsUpdate(existingPayment, paymentFields)) {
        await prisma.paymentTransaction.update({
          where: { id: paymentId },
          data: paymentFields,
        });
        paymentsTally.updated += 1;
      } else {
        paymentsTally.unchanged += 1;
      }
    }
  }

  console.log(describe('Ingresos', entriesTally));
  console.log(describe('Cobros (payment_transactions)', paymentsTally));
}

async function main(): Promise<void> {
  const required = ['tenants', 'vehicles', 'entries', 'rates'];
  for (const table of required) {
    const exists = await tableExists(table);
    if (!exists) {
      throw new Error(
        `Missing table "${table}". Apply migrations first (make migration-apply).`,
      );
    }
  }

  // Primero de todo: si quedan filas del seed viejo, chocan contra los índices
  // únicos parciales de tarifas y vehículos.
  await dropLegacySeedRows();

  await seedTenantProfiles();
  await seedTenantVehicles();
  await seedRates();
  await seedSchedules();
  await seedWhitelist();
  await seedCashSessions();

  await seedOnboarding();

  // Después del onboarding: los cobros necesitan los métodos de pago ya
  // sembrados para copiarles el nombre.
  await seedCustomPaymentMethods();
  await seedEntries();
}

/**
 * Onboarding-flow seed (idempotente). Requiere que `seed-auth` haya corrido
 * antes (necesita owner@example.com y owner-pending@example.com).
 * Corre como parte de `make seed-all` (seed-global -> seed-auth -> seed-tenant).
 */
async function seedOnboarding(): Promise<void> {
  const onboardingTables = [
    'onboarding_applications',
    'application_documents',
    'payment_methods',
  ];
  for (const table of onboardingTables) {
    if (!(await tableExists(table))) {
      console.warn(`⚠ Skipping onboarding seed: missing table "${table}".`);
      return;
    }
  }

  const owner = await prisma.user.findFirst({
    where: { email: 'owner@example.com' },
  });
  const ownerPending = await prisma.user.findFirst({
    where: { email: 'owner-pending@example.com' },
  });
  const admin = await prisma.user.findFirst({
    where: { email: 'admin@example.com' },
  });
  if (!owner || !ownerPending || !admin) {
    console.warn('⚠ Skipping onboarding seed: run `make seed-auth` first.');
    return;
  }

  // Servicios: sólo amenities. Los códigos VEHICLE_* se retiraron — "qué
  // vehículos acepta la playa" vive en `vehicle_types.accepted`, y las plazas
  // en `tenant.settings.capacity.total`.
  const demoServices: Record<string, { code: string; enabled: boolean }[]> = {
    [TENANTS.once]: [{ code: 'ADVANCE_RESERVATION', enabled: true }],
    [TENANTS.belgrano]: [{ code: 'ADVANCE_RESERVATION', enabled: false }],
    [TENANTS.palermo]: [{ code: 'ADVANCE_RESERVATION', enabled: true }],
  };
  for (const [tenantId, rows] of Object.entries(demoServices)) {
    for (const r of rows) {
      const code = r.code as ServiceCode;
      const existing = await prisma.service.findFirst({
        where: { tenantId, code },
      });
      if (!existing) {
        await prisma.service.create({
          data: { tenantId, code, enabled: r.enabled },
        });
      } else if (existing.enabled !== r.enabled) {
        await prisma.service.update({
          where: { id: existing.id },
          data: { enabled: r.enabled },
        });
      }
    }
  }

  await seedSystemPaymentMethods();

  // --- Solicitudes de alta (cola de PARKIT Ops) --------------------------
  //
  // Pertenecen al solicitante (owner-pending, un `user` común). Al aprobarse,
  // se materializa un tenant + una membresía de owner para el solicitante.
  //
  // Tres estados a propósito, porque la dirección se valida distinto en cada
  // uno y porque la cola del panel admin con un solo estado no prueba nada.
  await upsertApplication({
    id: APPLICATIONS.pending,
    applicantUserId: ownerPending.id,
    status: 'pending_review',
    submittedAt: at(-3, 12, 0),
    // Dirección ESTRUCTURADA y normalizada por Georef ("Av. Rivadavia 5000").
    // Es obligatorio: `submit()` no deja pasar a `pending_review` una
    // solicitud sin calle, altura, localidad y provincia
    // (`missingDeclaredAddressFields`). El seed viejo dejaba acá sólo el
    // `address` plano — o sea, una solicitud en revisión que la propia
    // aplicación habría rechazado, y que al aprobarse creaba un tenant sin
    // dirección estructurada (sin poder vincular Mercado Pago).
    declaredEntity: {
      name: 'Estacionamiento Caballito',
      legalName: 'Cocheras del Sur SRL',
      cuit: '30710099886',
      email: 'caballito@parkit.test',
      phone: '+541150000000',
      totalSpots: 45,
      location: {
        formatted: `AV RIVADAVIA 5000, Comuna 6, ${CABA}`,
        streetName: 'AV RIVADAVIA',
        streetNumber: '5000',
        floor: null,
        cityName: CABA,
        stateName: CABA,
        postalCode: null,
        latitude: -34.618301,
        longitude: -58.436457,
        geocodingSource: 'georef',
        geocodedAt: GEOCODED_AT.toISOString(),
      },
    },
  });

  await upsertApplication({
    id: APPLICATIONS.draft,
    applicantUserId: ownerPending.id,
    status: 'draft',
    submittedAt: null,
    // BORRADOR con la forma VIEJA del JSON: sólo `address` plano, sin
    // `location`. Existe en producción (borradores en vuelo de antes de la
    // migración) y es el caso que `readDeclaredAddress()` tolera. En `draft`
    // es perfectamente válido; lo que no puede es pasar a revisión así.
    declaredEntity: {
      name: 'Cochera Villa Crespo',
      address: 'Av. Corrientes 5200, CABA',
      legalName: 'Playa Crespo SA',
      cuit: '30712345671',
      email: 'crespo@parkit.test',
      phone: '+541151112222',
      totalSpots: 28,
    },
  });

  await upsertApplication({
    id: APPLICATIONS.rejected,
    applicantUserId: ownerPending.id,
    status: 'rejected',
    submittedAt: at(-20, 10, 30),
    reviewedAt: at(-18, 16, 45),
    reviewedBy: admin.id,
    rejectionReason:
      'El CUIT declarado no coincide con el del estatuto adjunto. Volvé a enviarla con la documentación corregida.',
    declaredEntity: {
      name: 'Estacionamiento Flores',
      legalName: 'Cocheras Flores SRL',
      cuit: '30698877665',
      email: 'flores@parkit.test',
      phone: '+541153334444',
      totalSpots: 60,
      location: {
        formatted: `AV RIVADAVIA 7000, Comuna 7, ${CABA}`,
        streetName: 'AV RIVADAVIA',
        streetNumber: '7000',
        floor: null,
        cityName: CABA,
        stateName: CABA,
        postalCode: null,
        latitude: -34.629252,
        longitude: -58.464112,
        geocodingSource: 'georef',
        geocodedAt: GEOCODED_AT.toISOString(),
      },
    },
  });

  await prisma.applicationDocument.upsert({
    where: { id: PENDING_DOCUMENT },
    create: {
      id: PENDING_DOCUMENT,
      applicationId: APPLICATIONS.pending,
      name: 'Estatuto social.pdf',
      storagePath: 'demo/cocheras-del-sur/estatuto.pdf',
      mimeType: 'application/pdf',
    },
    update: {},
  });

  console.log(
    '✓ Onboarding: 3 entidades activas y 3 solicitudes (pendiente, borrador y rechazada).',
  );
}

type SeedApplication = {
  id: string;
  applicantUserId: string;
  status: 'draft' | 'pending_review' | 'rejected';
  submittedAt: Date | null;
  reviewedAt?: Date;
  reviewedBy?: string;
  rejectionReason?: string;
  declaredEntity: Prisma.InputJsonValue;
};

async function upsertApplication(app: SeedApplication): Promise<void> {
  const data = {
    applicantUserId: app.applicantUserId,
    status: app.status,
    submittedAt: app.submittedAt,
    reviewedAt: app.reviewedAt ?? null,
    reviewedBy: app.reviewedBy ?? null,
    rejectionReason: app.rejectionReason ?? null,
    declaredEntity: app.declaredEntity,
  };
  await prisma.onboardingApplication.upsert({
    where: { id: app.id },
    create: { id: app.id, ...data },
    update: data,
  });
}

/**
 * Los dos métodos de pago DEL SISTEMA de cada entidad.
 *
 * Los nombres NO se escriben acá: vienen de
 * `src/entities/system-payment-methods.ts`, la misma constante contra la que
 * `system-payment-methods.spec.ts` verifica el SQL de
 * `bootstrap_tenant_defaults()`
 * (20260913163737_payment_methods_spanish_default_names.sql).
 *
 * ⚠ Y NO SE PISA UN NOMBRE QUE YA HAYA CAMBIADO UNA PERSONA.
 *
 * Antecedente: este bloque escribía los nombres técnicos inline y en cada
 * `make seed-all` revertía la migración en silencio. Importar la constante
 * arregla el VALOR, pero no el otro problema: un `update` incondicional
 * también le pisa al dueño el "Efectivo caja chica" que renombró a mano, y el
 * arqueo de caja lo detecta por nombre. La migración se cuida explícitamente
 * de eso (`WHERE name = 'cash'`); acá se hace lo mismo — sólo se corrige la
 * fila que conserva el nombre TÉCNICO viejo, que no lo eligió nadie: era el
 * valor del enum filtrándose a una columna de display.
 *
 * `is_default` tampoco se toca en filas existentes: si el dueño cambió con qué
 * método arranca el cobro, es una decisión suya.
 *
 * La unicidad por (tenant, type) para los métodos del sistema es un índice
 * único PARCIAL (WHERE is_system = true), que Prisma no puede apuntar en un
 * upsert; de ahí el findFirst + create/update.
 */
async function seedSystemPaymentMethods(): Promise<void> {
  const t = tally();
  const tenantIds = TENANT_PROFILES.map((p) => p.id);

  for (const tenantId of tenantIds) {
    for (const { type, name, isDefault } of SYSTEM_PAYMENT_METHOD_DEFAULTS) {
      const existing = await prisma.paymentMethod.findFirst({
        where: { tenantId, type, isSystem: true },
      });

      if (!existing) {
        await prisma.paymentMethod.create({
          data: {
            tenantId,
            type,
            name,
            enabled: true,
            isSystem: true,
            isDefault,
          },
        });
        t.created += 1;
        continue;
      }

      // `type` es el nombre técnico heredado del enum (pre-migración). Es el
      // ÚNICO nombre que el seed se permite corregir.
      if (existing.name === type) {
        await prisma.paymentMethod.update({
          where: { id: existing.id },
          data: { name },
        });
        t.updated += 1;
      } else {
        t.unchanged += 1;
      }
    }
  }

  console.log(
    describe(`Métodos de pago del sistema (${tenantIds.length} entidades)`, t),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
