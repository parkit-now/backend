// Local-only VOLUME seed: llena los dashboards del dueño con datos creíbles.
//
// Por qué existe aparte de `seed-tenant.ts`:
//
//   `seed-tenant.ts` es un seed CURADO. Sus cuatro entries, sus tasas borradas
//   y su tipo "Utilitario" están elegidos a mano para ejercitar casos puntuales
//   (tombstones del sync, unicidad parcial, el tipo que crea el dueño). Meterle
//   dos mil filas generadas taparía eso.
//
//   Este script es lo contrario: no le importa ningún caso borde, le importa
//   que `/metrics/*` y `/tenants/:id/audit` devuelvan algo que se pueda mirar.
//   Los dos conviven; este corre aparte con `make seed-demo`.
//
// LAS FECHAS SON RELATIVAS A HOY, no hardcodeadas. Ese era el problema real:
// los fixtures de `seed-tenant` están clavados en mayo de 2026, así que
// cualquier ventana de "últimos 7 / 30 días" del dashboard daba cero.
//
// IDEMPOTENTE por reemplazo: cada corrida borra lo que sembró antes (por
// prefijo de id, ver NS) y vuelve a generar. No toca ninguna fila de
// `seed-tenant`, `seed-auth` ni `seed-global`. Correrlo dos veces seguidas deja
// la base igual — pero mañana genera datos corridos un día, que es justo lo que
// se quiere de un seed de demo.
//
// Guardrails: idénticos a seed-tenant (localhost o nada).
//
// Trigger: `make seed-demo`.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error('✗ Refusing to seed demo data: SUPABASE_URL is not local.');
  console.error(`  SUPABASE_URL=${SUPABASE_URL || '(unset)'}`);
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('✗ Missing DATABASE_URL in env.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TENANTS = {
  once: '11111111-1111-4111-8111-111111111111',
  belgrano: '22222222-2222-4222-8222-222222222222',
} as const;

/**
 * Espacios de id propios de este seed, uno por tabla.
 *
 * Es lo que hace posible el "borrar y regenerar" sin tocar nada ajeno: el
 * cleanup es un DELETE ... WHERE id::text LIKE '<prefijo>%'. Los nibbles `4` y
 * `8` en las posiciones de versión y variante no son cosméticos — `@IsUUID()`
 * rechaza un uuid con versión fuera de 1-5, y estos ids viajan como parámetros
 * de query en el front.
 */
const NS = {
  entry: 'd0dddddd-dddd-4ddd-8ddd-',
  payment: 'd1dddddd-dddd-4ddd-8ddd-',
  lpr: 'd2dddddd-dddd-4ddd-8ddd-',
  audit: 'd3dddddd-dddd-4ddd-8ddd-',
  cash: 'd4dddddd-dddd-4ddd-8ddd-',
} as const;

/** Cuántos días de historia generar hacia atrás desde hoy. */
const DEMO_DAYS = 60;

/**
 * Argentina no aplica DST desde 2009, así que un offset fijo alcanza y evita
 * arrastrar una librería de zonas horarias a un script de seed. Si algún día
 * vuelve el horario de verano, esto miente por una hora en los bordes del día.
 */
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** PRNG determinístico (mulberry32): misma semilla, misma demo. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];

/** Elige de una lista de `[valor, peso]`. */
function weighted<T>(r: () => number, table: readonly (readonly [T, number])[]) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let roll = r() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return table[table.length - 1][0];
}

/** Id determinístico dentro de un namespace: `<prefijo><12 hex>`. */
const idOf = (ns: string, n: number): string =>
  ns + n.toString(16).padStart(12, '0');

/** Instante UTC de la medianoche local de hace `daysAgo` días. */
function localMidnight(now: Date, daysAgo: number): number {
  const localMs = now.getTime() - AR_OFFSET_MS;
  const dayIndex = Math.floor(localMs / DAY_MS) - daysAgo;
  return dayIndex * DAY_MS + AR_OFFSET_MS;
}

const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

// --- Pools de datos ---------------------------------------------------------

/** Patentes: mitad Mercosur (AB123CD), mitad viejas (ABC123). */
function buildPlates(count: number, seed: number): string[] {
  const r = rng(seed);
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const plates = new Set<string>();
  while (plates.size < count) {
    const l = () => L[Math.floor(r() * L.length)];
    const d = () => Math.floor(r() * 10).toString();
    plates.add(
      r() < 0.6
        ? `${l()}${l()}${d()}${d()}${d()}${l()}${l()}`
        : `${l()}${l()}${l()}${d()}${d()}${d()}`,
    );
  }
  return [...plates];
}

const COLORS = [
  'Blanco',
  'Negro',
  'Gris',
  'Rojo',
  'Azul',
  'Plata',
  'Verde',
] as const;

const MODELS: Record<string, readonly (readonly [string, string])[]> = {
  Auto: [
    ['Toyota', 'Corolla'],
    ['Volkswagen', 'Gol'],
    ['Fiat', 'Cronos'],
    ['Peugeot', '208'],
    ['Renault', 'Sandero'],
    ['Chevrolet', 'Onix'],
  ],
  SUV: [
    ['Toyota', 'Corolla Cross'],
    ['Volkswagen', 'Taos'],
    ['Jeep', 'Renegade'],
    ['Ford', 'Territory'],
  ],
  Pickup: [
    ['Toyota', 'Hilux'],
    ['Ford', 'Ranger'],
    ['Volkswagen', 'Amarok'],
  ],
  Moto: [
    ['Honda', 'Wave'],
    ['Zanella', 'RX 150'],
    ['Yamaha', 'YBR 125'],
    ['Corven', 'Energy'],
  ],
  Camión: [
    ['Mercedes-Benz', 'Accelo'],
    ['Iveco', 'Tector'],
  ],
  Utilitario: [
    ['Iveco', 'Daily'],
    ['Renault', 'Kangoo'],
    ['Fiat', 'Fiorino'],
  ],
  // Desde las categorías, las cuentas nuevas nacen con "Utilitario / Van".
  'Utilitario / Van': [
    ['Iveco', 'Daily'],
    ['Renault', 'Kangoo'],
    ['Fiat', 'Fiorino'],
  ],
  Bici: [['Vairo', 'XR 3.5']],
  Otro: [['Genérico', 'Sin especificar']],
};

/**
 * Mezcla de tipos de vehículo del lote. Los pesos son la parte que hace que el
 * gráfico se vea como un estacionamiento y no como un histograma plano.
 */
const TYPE_MIX = [
  ['Auto', 52],
  ['Moto', 18],
  ['SUV', 11],
  ['Pickup', 8],
  ['Utilitario', 5],
  ['Utilitario / Van', 5],
  ['Camión', 3],
  ['Otro', 2],
  ['Bici', 1],
] as const;

const CAMERAS = ['cam-entrada-01', 'cam-entrada-02', 'cam-salida-01'] as const;

// --- Generación -------------------------------------------------------------

type TenantPlan = {
  id: string;
  label: string;
  capacity: number;
  /** Llegadas por día hábil (los fines de semana se recortan a la mitad). */
  arrivalsPerWeekday: number;
  seed: number;
};

/**
 * Las llegadas por día NO son un número decorativo: de ellas sale la ocupación.
 *
 * Con estadías de ~3,3 h promedio repartidas en 15 h de actividad, los autos
 * adentro en un momento dado son aproximadamente
 * `llegadas / 15 h × 3,3 h`. Para Once: 160/15 × 3,3 ≈ 35 sobre 55 plazas
 * (64%). Belgrano: 95/15 × 3,3 ≈ 21 sobre 33 (63%).
 *
 * La primera versión de este seed usaba 24 llegadas/día y after agregaba autos
 * abiertos aparte para forzar la ocupación. Eso inflaba `vehiclesIn` del día en
 * curso y el dashboard mostraba un +268% contra ayer que parecía un bug de
 * cálculo. La ocupación tiene que EMERGER del ritmo de llegadas.
 */
const PLANS: TenantPlan[] = [
  {
    id: TENANTS.once,
    label: 'Once',
    capacity: 55,
    arrivalsPerWeekday: 160,
    seed: 0x0e11,
  },
  {
    id: TENANTS.belgrano,
    label: 'Belgrano',
    capacity: 33,
    arrivalsPerWeekday: 95,
    seed: 0xbe19,
  },
];

type EntryRow = {
  id: string;
  tenantId: string;
  plate: string;
  color: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleType: string;
  vehicleTypeId: string;
  vehicleCategory: string;
  enteredAt: Date;
  leftAt: Date | null;
  amountPaid: string | null;
  source: string;
  cochera: string | null;
  rateId: string | null;
  rateSnapshotName: string | null;
  rateSnapshotHourPriceArs: string | null;
  /**
   * La caja donde "está" el auto: la del turno en que salió, o la abierta si
   * sigue adentro. Es lo que deja el traspaso de `closeSession`, que mueve al
   * turno nuevo cada auto que sigue adentro. NO es la caja que cobró.
   */
  cashSessionId: string;
};

type PaymentRow = {
  id: string;
  tenantId: string;
  entryId: string;
  /** La caja que COBRÓ. Es la que usa el filtro `cashSessionId` de /metrics. */
  cashSessionId: string;
  paymentMethodId: string | null;
  paymentMethodName: string;
  /**
   * Tercer campo del snapshot del medio, NOT NULL y sin default desde
   * `20260913200901_payment_transactions_method_type_snapshot.sql`: el arqueo
   * decide qué plata entró al cajón por el tipo y ya no adivinando por el
   * nombre. Sin esto, el seed falla al insertar.
   */
  paymentMethodType: Prisma.PaymentTransactionCreateManyInput['paymentMethodType'];
  amount: string;
};

type CashSessionRow = {
  id: string;
  tenantId: string;
  openedAt: Date;
  closedAt: Date | null;
  openingCash: string;
  leavingCash: string | null;
};

/**
 * Turnos de caja: tres de ocho horas por día (06–14, 14–22, 22–06), como una
 * playa que abre las 24 h. El que contiene "ahora" queda abierto.
 */
const SHIFT_MS = 8 * 60 * 60 * 1000;
const FIRST_SHIFT_HOUR = 6;

/** Fondo fijo: lo que queda en el cajón al pasar de un turno al siguiente. */
const CASH_FLOAT = '20000.00';

/**
 * Cobros registrados con la caja del turno ANTERIOR aunque su `leftAt` ya cae
 * en el siguiente: la terminal que cerró el turno tenía otro reloj, o el
 * desktop sincronizó offline. Es exactamente el caso que rompe aproximar una
 * caja por su ventana de reloj, y el que `/metrics?cashSessionId=` resuelve
 * ensanchando la ventana — se siembran a propósito para poder verificarlo.
 *
 * Sólo en los primeros minutos de un turno y con esta probabilidad: cerca del
 * 1% de los cierres.
 */
const LATE_SYNC_WINDOW_MS = 20 * 60 * 1000;
const LATE_SYNC_RATE = 0.25;

/** Borra sólo lo que sembró este script. Hijos antes que padres (FK). */
async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM payment_transactions WHERE id::text LIKE '${NS.payment}%'`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM lpr_detection_events WHERE id::text LIKE '${NS.lpr}%'`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM entries WHERE id::text LIKE '${NS.entry}%'`,
  );
  // Después de entries y transacciones, que la referencian. La FK es
  // ON DELETE SET NULL, así que el orden no rompe nada — pero así no se
  // reescriben filas que se van a borrar igual.
  await prisma.$executeRawUnsafe(
    `DELETE FROM cash_sessions WHERE id::text LIKE '${NS.cash}%'`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_log WHERE id::text LIKE '${NS.audit}%'`,
  );
}

async function insertChunked<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

async function main(): Promise<void> {
  const now = new Date();

  await cleanup();

  const sessions: CashSessionRow[] = [];
  const entries: EntryRow[] = [];
  const payments: PaymentRow[] = [];
  let sessionSeq = 0;
  let entrySeq = 0;
  let paymentSeq = 0;
  let lateSynced = 0;

  for (const plan of PLANS) {
    const r = rng(plan.seed);

    // Tipos y métodos salen de la DB, no de constantes: los siembra el trigger
    // `bootstrap_tenant_defaults()` y renombrarlos es justamente la feature.
    const types = await prisma.vehicleType.findMany({
      where: { tenantId: plan.id, deletedAt: null },
      select: { id: true, name: true, category: true },
    });
    const typeByName = new Map(types.map((t) => [t.name, t]));
    const typeNames = new Set(typeByName.keys());
    if (typeNames.size === 0) {
      console.error(
        `✗ ${plan.label} no tiene vehicle_types. Corré 'make seed-all' primero.`,
      );
      process.exit(1);
    }
    // Sólo los tipos que el lote realmente tiene; el resto del mix se descarta.
    const mix = TYPE_MIX.filter(([name]) => typeNames.has(name));

    const methods = await prisma.paymentMethod.findMany({
      where: { tenantId: plan.id, enabled: true },
      // `type` viaja al cobro como snapshot: es lo que mira el arqueo para
      // saber qué entró al cajón, y desde la migración del snapshot es NOT NULL.
      select: { id: true, name: true, type: true },
    });

    const rate = await prisma.rate.findFirst({
      where: { tenantId: plan.id, isActive: true, deletedAt: null },
      select: { id: true, name: true, hourPriceArs: true },
    });
    const hourPrice = rate ? Number(rate.hourPriceArs) : 4500;

    // Dos poblaciones, que es como se comporta un estacionamiento real: un
    // núcleo chico de habitués y una cola larga de ocasionales.
    //
    // La primera versión usaba un único pool de 90 patentes con caída Zipf
    // (`pow(r, 2.2)`), y la patente top acumulaba 494 visitas en 30 días —
    // dieciséis por día para un mismo auto. En el dashboard eso no se lee como
    // "cliente fiel", se lee como un bug de agrupamiento.
    const REGULARS = 60;
    const plates = buildPlates(3060, plan.seed);
    const regulars = plates.slice(0, REGULARS);
    const casual = plates.slice(REGULARS);
    const plateOf = () => (r() < 0.12 ? pick(r, regulars) : pick(r, casual));

    // Turnos del período, de corrido. `cash_sessions_tenant_open_idx` admite
    // una sola caja abierta por tenant: si ya hay una que no es de este seed
    // (una prueba a mano desde el desktop, digamos), el turno actual se cierra
    // ahora en vez de quedar abierto, para no chocar con el índice.
    const firstShiftStart =
      localMidnight(now, DEMO_DAYS - 1) + FIRST_SHIFT_HOUR * 3600_000;
    const shiftIndexAt = (ms: number): number =>
      Math.max(0, Math.floor((ms - firstShiftStart) / SHIFT_MS));
    const currentShift = shiftIndexAt(now.getTime());
    const foreignOpen = await prisma.cashSession.findFirst({
      where: { tenantId: plan.id, closedAt: null },
      select: { id: true },
    });

    const shiftIds: string[] = [];
    for (let i = 0; i <= currentShift; i++) {
      const openedAt = new Date(firstShiftStart + i * SHIFT_MS);
      const closedAt =
        i < currentShift
          ? new Date(openedAt.getTime() + SHIFT_MS)
          : foreignOpen
            ? now
            : null;
      const id = idOf(NS.cash, sessionSeq++);
      shiftIds.push(id);
      sessions.push({
        id,
        tenantId: plan.id,
        openedAt,
        closedAt,
        openingCash: CASH_FLOAT,
        leavingCash: closedAt ? CASH_FLOAT : null,
      });
    }

    for (let daysAgo = DEMO_DAYS - 1; daysAgo >= 0; daysAgo--) {
      const dayStart = localMidnight(now, daysAgo);
      const weekday = new Date(dayStart + AR_OFFSET_MS).getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;

      // Variación diaria ±20% sobre la base, y el fin de semana a la mitad.
      const target = Math.round(
        plan.arrivalsPerWeekday * (isWeekend ? 0.5 : 1) * (0.8 + r() * 0.4),
      );

      for (let i = 0; i < target; i++) {
        // Llegadas entre las 07:00 y las 22:00 locales, con dos picos suaves
        // (mañana y tarde) en vez de una uniforme.
        const peak = r() < 0.55 ? 8 : 15;
        const hour = Math.min(
          22,
          Math.max(7, peak + (r() - 0.5) * 6 + (r() - 0.5) * 4),
        );
        const enteredAt = new Date(dayStart + hour * 3600_000 + r() * 3600_000);
        if (enteredAt.getTime() > now.getTime()) continue;

        // Estadías cortas dominan, con cola larga hacia las 10 horas.
        const stayMinutes = Math.round(30 + Math.pow(r(), 2.4) * 570);
        const leftMs = enteredAt.getTime() + stayMinutes * 60_000;
        const stillOpen = leftMs > now.getTime();

        const typeName = weighted(r, mix);
        const [brand, model] = pick(r, MODELS[typeName] ?? MODELS.Otro);

        const billedHours = Math.max(1, Math.ceil(stayMinutes / 60));
        const amount = hourPrice * billedHours * (0.92 + r() * 0.16);

        const id = idOf(NS.entry, entrySeq++);
        entries.push({
          id,
          tenantId: plan.id,
          plate: plateOf(),
          color: pick(r, COLORS),
          vehicleBrand: brand,
          vehicleModel: model,
          // Se llena SIEMPRE, a diferencia de la app real, donde hoy sólo lo
          // escribe el ingreso por LPR. Si quedara null como en producción, el
          // filtro por tipo y `byVehicleType` no tendrían nada que mostrar y
          // este seed no cumpliría su función. Desde las categorías el alta
          // manual también lo escribe (con `vehicleTypeId` y `vehicleCategory`).
          vehicleType: typeName,
          vehicleTypeId: typeByName.get(typeName)!.id,
          vehicleCategory: typeByName.get(typeName)!.category,
          enteredAt,
          leftAt: stillOpen ? null : new Date(leftMs),
          amountPaid: stillOpen ? null : money(amount),
          source: r() < 0.35 ? 'auto' : 'manual',
          cochera: r() < 0.5 ? `${1 + Math.floor(r() * plan.capacity)}` : null,
          rateId: rate?.id ?? null,
          rateSnapshotName: rate?.name ?? null,
          rateSnapshotHourPriceArs: rate ? money(hourPrice) : null,
          // Adentro: la caja abierta (el traspaso lo fue moviendo turno a
          // turno). Cerrado: la del turno en que salió.
          cashSessionId:
            shiftIds[shiftIndexAt(stillOpen ? now.getTime() : leftMs)],
        });

        if (stillOpen || methods.length === 0) continue;

        // ~15% se cierra por el fallback offline de `amountPaid` sin detalle de
        // pagos. Es lo que alimenta la porción `unallocated` de la torta: si
        // todas tuvieran transacciones, el reconciliador quedaría sin demostrar.
        // Esas estadías no tienen caja cobradora, así que tampoco aparecen al
        // filtrar /metrics por caja — que es justamente la semántica del filtro.
        if (r() < 0.15) continue;

        // La caja que cobró: la del turno en que salió, salvo los sincronizados
        // tarde, que llegan con la del turno anterior (ver LATE_SYNC_RATE).
        const exitShift = shiftIndexAt(leftMs);
        const intoShiftMs = leftMs - (firstShiftStart + exitShift * SHIFT_MS);
        let paidShift = exitShift;
        if (
          exitShift > 0 &&
          intoShiftMs < LATE_SYNC_WINDOW_MS &&
          r() < LATE_SYNC_RATE
        ) {
          paidShift = exitShift - 1;
          lateSynced++;
        }
        const paidSessionId = shiftIds[paidShift];

        const split = methods.length > 1 && r() < 0.28;
        if (split) {
          const first = Math.round(amount * (0.3 + r() * 0.4) * 100) / 100;
          payments.push({
            id: idOf(NS.payment, paymentSeq++),
            tenantId: plan.id,
            entryId: id,
            cashSessionId: paidSessionId,
            paymentMethodId: methods[0].id,
            paymentMethodName: methods[0].name,
            paymentMethodType: methods[0].type,
            amount: money(first),
          });
          payments.push({
            id: idOf(NS.payment, paymentSeq++),
            tenantId: plan.id,
            entryId: id,
            cashSessionId: paidSessionId,
            paymentMethodId: methods[1].id,
            paymentMethodName: methods[1].name,
            paymentMethodType: methods[1].type,
            amount: money(amount - first),
          });
        } else {
          const m = pick(r, methods);
          payments.push({
            id: idOf(NS.payment, paymentSeq++),
            tenantId: plan.id,
            entryId: id,
            cashSessionId: paidSessionId,
            paymentMethodId: m.id,
            paymentMethodName: m.name,
            paymentMethodType: m.type,
            amount: money(amount),
          });
        }
      }
    }
  }

  // Cajas primero: entries y transacciones las referencian por FK.
  await insertChunked(sessions, (chunk) =>
    prisma.cashSession.createMany({ data: chunk, skipDuplicates: true }),
  );
  await insertChunked(entries, (chunk) =>
    prisma.entry.createMany({ data: chunk, skipDuplicates: true }),
  );
  await insertChunked(payments, (chunk) =>
    prisma.paymentTransaction.createMany({ data: chunk, skipDuplicates: true }),
  );

  const closed = entries.filter((e) => e.leftAt !== null).length;
  console.log(
    `✓ ${entries.length} entries (${closed} cerradas, ${entries.length - closed} adentro) y ${payments.length} transacciones, últimos ${DEMO_DAYS} días.`,
  );
  console.log(
    `✓ ${sessions.length} turnos de caja; ${lateSynced} cobros registrados por el turno anterior al de su salida (para verificar el ensanchado).`,
  );

  await seedLprEvents(now, entries);
  await seedAuditLog(now);
}

/**
 * Eventos LPR. Los `pending` son los que alimentan `alerts.pendingLprEvents`
 * del summary, que hoy siempre muestra 0.
 */
async function seedLprEvents(now: Date, entries: EntryRow[]): Promise<void> {
  const rows: {
    id: string;
    tenantId: string;
    cameraId: string;
    location: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    rawText: string;
    normalizedText: string;
    displayPlate: string;
    confidence: number;
    formatValid: boolean;
    formatType: 'argentina_mercosur' | 'argentina_old' | 'unknown';
    qualityStatus: 'valid_high' | 'valid_low' | 'low_confidence';
    status: 'pending' | 'registered' | 'dismissed';
    entryId: string | null;
    reviewedAt: Date | null;
  }[] = [];

  let seq = 0;
  for (const plan of PLANS) {
    const r = rng(plan.seed ^ 0x5c17);
    const recent = entries
      .filter((e) => e.tenantId === plan.id && e.leftAt === null)
      .slice(0, 20);

    // 6 pendientes (las alertas) + 10 ya resueltos, para que el listado tenga
    // algo que filtrar por estado.
    for (let i = 0; i < 16; i++) {
      const pending = i < 6;
      const seenAt = new Date(
        now.getTime() - (pending ? r() * 6 : 2 + r() * 8) * 3600_000,
      );
      const linked = !pending && recent.length > 0 ? pick(r, recent) : null;
      const plate = linked?.plate ?? pick(r, buildPlates(20, plan.seed + i));
      const confidence = pending ? 0.55 + r() * 0.2 : 0.85 + r() * 0.14;

      rows.push({
        id: idOf(NS.lpr, seq++),
        tenantId: plan.id,
        cameraId: pick(r, CAMERAS),
        location: r() < 0.7 ? 'entrada' : 'salida',
        firstSeenAt: seenAt,
        lastSeenAt: new Date(seenAt.getTime() + 4000),
        rawText: plate,
        normalizedText: plate,
        displayPlate: plate,
        confidence: Math.round(confidence * 100) / 100,
        formatValid: !pending,
        formatType: plate.length === 7 ? 'argentina_mercosur' : 'argentina_old',
        qualityStatus: pending
          ? 'low_confidence'
          : confidence > 0.92
            ? 'valid_high'
            : 'valid_low',
        status: pending ? 'pending' : r() < 0.7 ? 'registered' : 'dismissed',
        entryId: pending ? null : (linked?.id ?? null),
        reviewedAt: pending ? null : new Date(seenAt.getTime() + 90_000),
      });
    }
  }

  await insertChunked(rows, (chunk) =>
    prisma.lprDetectionEvent.createMany({ data: chunk, skipDuplicates: true }),
  );
  const pending = rows.filter((e) => e.status === 'pending').length;
  console.log(`✓ ${rows.length} eventos LPR (${pending} pendientes de revisión).`);
}

/**
 * Auditoría. La tabla nace vacía en local, así que el dashboard de auditoría
 * arranca sin una sola fila y no se puede revisar ni el filtro ni la paginación.
 */
async function seedAuditLog(now: Date): Promise<void> {
  const actors = await prisma.user.findMany({
    where: {
      email: { in: ['owner@example.com', 'admin@example.com'] },
    },
    select: { id: true, email: true },
  });
  if (actors.length === 0) {
    console.warn('⚠ Sin auditoría: corré `make seed-auth` primero.');
    return;
  }

  const CATALOG = [
    ['entity.profile_updated', 'tenant', 'info', 6],
    ['payment_method.toggled', 'payment_method', 'info', 5],
    ['lpr_event.registered', 'lpr_detection_event', 'info', 8],
    ['lpr_event.dismissed', 'lpr_detection_event', 'warn', 4],
    ['lpr_event.archived', 'lpr_detection_event', 'info', 3],
    ['membership.created', 'user_membership', 'info', 2],
    ['membership.updated', 'user_membership', 'warn', 2],
    ['user.role_updated', 'user', 'crit', 1],
    ['entity.approved', 'tenant', 'info', 1],
  ] as const;

  const rows: {
    id: string;
    tenantId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    severity: 'info' | 'warn' | 'crit';
    metadata: Prisma.InputJsonValue;
    createdAt: Date;
  }[] = [];

  let seq = 0;
  for (const plan of PLANS) {
    const r = rng(plan.seed ^ 0xa0d1);
    for (let i = 0; i < 45; i++) {
      const [action, entityType, severity] = weighted(
        r,
        CATALOG.map((c) => [c, c[3]] as const),
      );
      const daysAgo = Math.floor(Math.pow(r(), 1.7) * DEMO_DAYS);
      const createdAt = new Date(
        localMidnight(now, daysAgo) + (8 + r() * 12) * 3600_000,
      );
      if (createdAt.getTime() > now.getTime()) continue;

      const actor = pick(r, actors);
      rows.push({
        id: idOf(NS.audit, seq++),
        tenantId: plan.id,
        actorUserId: actor.id,
        action,
        entityType,
        severity,
        metadata: { demo: true, lot: plan.label },
        createdAt,
      });
    }
  }

  await insertChunked(rows, (chunk) =>
    prisma.auditLog.createMany({ data: chunk, skipDuplicates: true }),
  );
  console.log(`✓ ${rows.length} eventos de auditoría, últimos ${DEMO_DAYS} días.`);
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
