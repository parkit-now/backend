/**
 * Check-in de reservas en la caja (fase 6, ampliado en la 6c): qué reserva
 * corresponde a un auto que llega, cuánto pagó por adelantado y las
 * transiciones que dispara la caja (`confirmed → checked_in` al ingresar,
 * `checked_in → completed` al salir y, al desvincular, la vuelta atrás).
 *
 * Las funciones de base reciben el cliente de la TRANSACCIÓN del ingreso o del
 * cierre: el vínculo y la estadía van juntos o no va ninguno. Por eso el
 * `tenantId` viaja explícito, igual que en `EntriesService` y en el ciclo de
 * vida.
 *
 * ## Rangos de llegada (fase 6c)
 *
 * Para una reserva de `entryAt` a `exitAt`, un auto que llega en `at` es:
 *
 *   too_early   at < entryAt − tope                  no se vincula (aviso)
 *   early       entryAt − tope ≤ at < ventana.desde  se vincula, "llegó antes"
 *   on_time     ventana.desde ≤ at ≤ ventana.hasta   se vincula, como en la fase 6
 *   late        ventana.hasta < at ≤ exitAt          se vincula, "llegó tarde"
 *   too_late    at > exitAt                          no se vincula
 *
 * con `ventana = [entryAt − earlyArrivalMinutes, entryAt + graceMinutes]` y
 * `tope = max(earlyArrivalMaxMinutes, earlyArrivalMinutes)`. Las reglas salen
 * del `policySnapshot` de la reserva; el tope, si la reserva es anterior a la
 * 6c y no lo tiene, del valor vivo del servicio. El tiempo extra de una
 * llegada anticipada no necesita nada especial: el cobro ya es
 * `max(calcStayPrice(estadía real) − prepago, 0)`.
 */
import {
  Prisma,
  ReservationPaymentStatus,
  ReservationStatus,
  ServiceCode,
} from '@prisma/client';
import { normalizePlate } from '../driver/driver-rules';
import {
  DEFAULT_POLICY_SNAPSHOT,
  readPolicySnapshot,
  snapshotEarlyArrivalMax,
} from './reservation-policy';

/**
 * Topes de `services.early_arrival_minutes`, `services.grace_minutes`
 * (migración 20261003120000) y `services.early_arrival_max_minutes`
 * (20261007120000). Acotan la búsqueda en la base; los rangos exactos de cada
 * reserva salen de su `policySnapshot`.
 */
export const MAX_EARLY_ARRIVAL_MINUTES = 120;
export const MAX_GRACE_MINUTES = 180;
export const MAX_EARLY_ARRIVAL_MAX_MINUTES = 1440;

/**
 * Estados desde los que un ingreso puede vincularse.
 *
 * `no_show` entra a propósito: el sweeper lo pone apenas vence la tolerancia
 * sin ingreso, pero el auto puede llegar tarde (hasta `exitAt`) o haber
 * entrado SIN CONEXIÓN a tiempo y recién sincronizar ahora. En los dos casos
 * la reserva no fue un no-show. No mueve plata: el no-show no se reembolsa,
 * así que volver a `checked_in` sólo corrige el estado.
 */
export const LINKABLE_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.confirmed,
  ReservationStatus.no_show,
];

/** Rangos en los que el ingreso se vincula. */
export type ArrivalKind = 'early' | 'on_time' | 'late';
/** Todos los rangos, incluidos los que no vinculan. */
export type ArrivalClass = ArrivalKind | 'too_early' | 'too_late';

const LINKABLE_ARRIVALS: readonly ArrivalClass[] = ['early', 'on_time', 'late'];

export function isLinkableArrival(
  arrival: ArrivalClass,
): arrival is ArrivalKind {
  return LINKABLE_ARRIVALS.includes(arrival);
}

type WindowSource = {
  entryAt: Date;
  policySnapshot: unknown;
};

type SlotSource = WindowSource & { exitAt: Date };

/**
 * Ventana NORMAL de llegada de una reserva: `[entryAt − earlyArrival, entryAt
 * + grace]`, con las reglas que tenía la playa al reservar.
 */
export function arrivalWindow(reservation: WindowSource): {
  from: Date;
  until: Date;
} {
  const policy = readPolicySnapshot(reservation.policySnapshot);
  const entryMs = reservation.entryAt.getTime();
  return {
    from: new Date(entryMs - policy.earlyArrivalMinutes * 60_000),
    until: new Date(entryMs + policy.graceMinutes * 60_000),
  };
}

/**
 * Tope de la llegada anticipada de una reserva, en minutos: el de su foto o,
 * si es anterior a la 6c, `fallbackMinutes` (el valor vivo del servicio).
 * Nunca menor que la llegada anticipada normal.
 */
export function earlyArrivalMaxOf(
  reservation: WindowSource,
  fallbackMinutes: number,
): number {
  const policy = readPolicySnapshot(reservation.policySnapshot);
  const max =
    snapshotEarlyArrivalMax(reservation.policySnapshot) ?? fallbackMinutes;
  return Math.max(max, policy.earlyArrivalMinutes);
}

/**
 * Desde y hasta cuándo un ingreso se vincula a la reserva: desde el tope de
 * llegada anticipada hasta `exitAt` (o el fin de la tolerancia, si una reserva
 * corta termina antes).
 */
export function linkableWindow(
  reservation: SlotSource,
  fallbackEarlyMaxMinutes: number = DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes,
): { from: Date; until: Date } {
  const normal = arrivalWindow(reservation);
  const earlyMax = earlyArrivalMaxOf(reservation, fallbackEarlyMaxMinutes);
  return {
    from: new Date(reservation.entryAt.getTime() - earlyMax * 60_000),
    until: new Date(
      Math.max(reservation.exitAt.getTime(), normal.until.getTime()),
    ),
  };
}

export type ArrivalClassification = {
  arrival: ArrivalClass;
  /** Minutos antes de `entryAt` (0 si llegó después). */
  minutesEarly: number;
  /** Minutos después de `entryAt` (0 si llegó antes). */
  minutesLate: number;
};

function minutesAround(entryAt: Date, at: Date) {
  const diff = Math.round((entryAt.getTime() - at.getTime()) / 60_000);
  return { minutesEarly: Math.max(diff, 0), minutesLate: Math.max(-diff, 0) };
}

/** En qué rango cae un auto que llega en `at` (ver el encabezado). */
export function classifyArrival(
  reservation: SlotSource,
  at: Date,
  fallbackEarlyMaxMinutes: number = DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes,
): ArrivalClassification {
  const ms = at.getTime();
  const normal = arrivalWindow(reservation);
  const linkable = linkableWindow(reservation, fallbackEarlyMaxMinutes);
  let arrival: ArrivalClass;
  if (ms < linkable.from.getTime()) arrival = 'too_early';
  else if (ms < normal.from.getTime()) arrival = 'early';
  else if (ms <= normal.until.getTime()) arrival = 'on_time';
  else if (ms <= linkable.until.getTime()) arrival = 'late';
  else arrival = 'too_late';
  return { arrival, ...minutesAround(reservation.entryAt, at) };
}

/**
 * Cómo llegó un auto YA vinculado (para mostrarlo: "llegó antes", "llegó
 * tarde"). No necesita el tope: si está vinculado, entró dentro de él.
 */
export function stayArrival(
  reservation: WindowSource,
  enteredAt: Date,
): { arrival: ArrivalKind; minutesEarly: number; minutesLate: number } {
  const normal = arrivalWindow(reservation);
  const ms = enteredAt.getTime();
  const arrival: ArrivalKind =
    ms < normal.from.getTime()
      ? 'early'
      : ms > normal.until.getTime()
        ? 'late'
        : 'on_time';
  return { arrival, ...minutesAround(reservation.entryAt, enteredAt) };
}

export function isWithinArrivalWindow(
  reservation: WindowSource,
  at: Date,
): boolean {
  const { from, until } = arrivalWindow(reservation);
  const ms = at.getTime();
  return ms >= from.getTime() && ms <= until.getTime();
}

/**
 * Qué reservas buscar en la base para una llegada en `at`: cualquiera cuyo
 * rango vinculable pueda incluirla. Empieza a lo sumo `MAX_EARLY_ARRIVAL_MAX`
 * después de `at`, y termina (su `exitAt`, o su tolerancia) no antes de `at`.
 * El filtro fino lo hace `classifyArrival`.
 */
export function arrivalSearchRange(at: Date): Prisma.ReservationWhereInput {
  return {
    entryAt: {
      lte: new Date(at.getTime() + MAX_EARLY_ARRIVAL_MAX_MINUTES * 60_000),
    },
    OR: [
      { exitAt: { gte: at } },
      { entryAt: { gte: new Date(at.getTime() - MAX_GRACE_MINUTES * 60_000) } },
    ],
  };
}

type Candidate = SlotSource & { id: string; status: ReservationStatus };

const ARRIVAL_RANK: Record<ArrivalKind, number> = {
  on_time: 0,
  early: 1,
  late: 1,
};

/**
 * La reserva que corresponde a un auto que llega en `at`, o `null`, con el
 * rango en el que cayó.
 *
 * Sólo cuentan las vinculables (`LINKABLE_STATUSES`) que caen en un rango que
 * vincula (antes, a tiempo o tarde). Si la caja eligió una (`preferredId`, la
 * del banner) y sigue siendo válida, gana esa. Si no, primero las que llegan a
 * tiempo; después la de `entryAt` más cercana (dos reservas de la misma
 * patente el mismo día, una a la mañana y otra a la tarde), y a igual
 * distancia la `confirmed` antes que la `no_show`.
 */
export function pickReservationForArrival<T extends Candidate>(
  candidates: readonly T[],
  at: Date,
  preferredId?: string | null,
  fallbackEarlyMaxMinutes: number = DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes,
):
  | (T & { classification: ArrivalClassification & { arrival: ArrivalKind } })
  | null {
  const eligible = candidates
    .filter((candidate) => LINKABLE_STATUSES.includes(candidate.status))
    .map((candidate) => ({
      ...candidate,
      classification: classifyArrival(candidate, at, fallbackEarlyMaxMinutes),
    }))
    .filter(
      (
        candidate,
      ): candidate is T & {
        classification: ArrivalClassification & { arrival: ArrivalKind };
      } => isLinkableArrival(candidate.classification.arrival),
    );
  if (eligible.length === 0) return null;

  if (preferredId) {
    const preferred = eligible.find(
      (candidate) => candidate.id === preferredId,
    );
    if (preferred) return preferred;
  }

  const distance = (candidate: T) =>
    Math.abs(candidate.entryAt.getTime() - at.getTime());
  const rank = (candidate: T) =>
    candidate.status === ReservationStatus.confirmed ? 0 : 1;
  return [...eligible].sort(
    (left, right) =>
      ARRIVAL_RANK[left.classification.arrival] -
        ARRIVAL_RANK[right.classification.arrival] ||
      distance(left) - distance(right) ||
      rank(left) - rank(right) ||
      left.id.localeCompare(right.id),
  )[0];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Lo que el conductor pagó por adelantado: la suma de sus pagos aprobados.
 * Sin pago registrado pero con `paidAt` (reservas anteriores a la tabla de
 * pagos) vale el total. Sin nada —el camino viejo sin pago, que sólo existe
 * fuera de producción— vale 0: la caja cobra la estadía entera.
 */
export function prepaidAmountOf(reservation: {
  totalArs: Prisma.Decimal | number;
  paidAt: Date | null;
  payments: { amountArs: Prisma.Decimal | number }[];
}): number {
  const approved = reservation.payments.reduce(
    (sum, payment) => sum + Number(payment.amountArs),
    0,
  );
  if (approved > 0) return round2(approved);
  if (reservation.paidAt !== null) return round2(Number(reservation.totalArs));
  return 0;
}

/** Lo que se lee de cada reserva candidata (match y vínculo). */
export const ARRIVAL_SELECT = {
  id: true,
  status: true,
  vehiclePlate: true,
  vehicleCategory: true,
  entryAt: true,
  exitAt: true,
  totalArs: true,
  paidAt: true,
  policySnapshot: true,
  user: { select: { name: true } },
  payments: {
    where: { status: ReservationPaymentStatus.approved },
    select: { amountArs: true },
  },
} satisfies Prisma.ReservationSelect;

export type ArrivalCandidate = Prisma.ReservationGetPayload<{
  select: typeof ARRIVAL_SELECT;
}>;

type ReservationDb = Pick<Prisma.TransactionClient, 'reservation'>;
type ArrivalDb = Pick<Prisma.TransactionClient, 'reservation' | 'service'>;

/**
 * `where` de las reservas vinculables de una patente cuyo rango vinculable
 * puede incluir `at`, o `null` si la patente no tiene nada utilizable.
 */
export function arrivalCandidatesWhere(
  tenantId: string,
  plate: string,
  at: Date,
): Prisma.ReservationWhereInput | null {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  return {
    tenantId,
    vehiclePlate: normalized,
    status: { in: [...LINKABLE_STATUSES] },
    ...arrivalSearchRange(at),
  };
}

/** Las reservas vinculables de una patente cuyo rango puede incluir `at`. */
export async function findArrivalCandidates(
  db: ReservationDb,
  tenantId: string,
  plate: string,
  at: Date,
): Promise<ArrivalCandidate[]> {
  const where = arrivalCandidatesWhere(tenantId, plate, at);
  if (!where) return [];
  return db.reservation.findMany({ where, select: ARRIVAL_SELECT });
}

/**
 * El tope de llegada anticipada vivo del servicio, para las reservas que no
 * lo tienen en su foto (anteriores a la 6c). Sólo consulta la base si alguna
 * candidata lo necesita: lo normal es que no.
 */
export async function fallbackEarlyArrivalMax(
  db: Pick<Prisma.TransactionClient, 'service'>,
  tenantId: string,
  candidates: readonly WindowSource[],
): Promise<number> {
  const needed = candidates.some(
    (candidate) => snapshotEarlyArrivalMax(candidate.policySnapshot) === null,
  );
  if (!needed) return DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes;
  const service = await db.service.findFirst({
    where: { tenantId, code: ServiceCode.ADVANCE_RESERVATION },
    select: { earlyArrivalMaxMinutes: true },
  });
  return (
    service?.earlyArrivalMaxMinutes ??
    DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes
  );
}

/** Hasta dónde mira el aviso de "tiene una reserva más tarde". */
export const UPCOMING_LOOKAHEAD_MINUTES = 24 * 60;

/**
 * La próxima reserva `confirmed` de esa patente a la que todavía es muy
 * temprano para vincular, dentro de las próximas 24 h: el aviso "Esta patente
 * tiene una reserva hoy (o mañana) a las HH:MM" de la caja.
 *
 * Son 24 h y no el día civil a propósito: una playa abierta de noche recibe a
 * las 23:30 al que reservó para la 01:00, y "hoy" terminaría a medianoche
 * justo cuando el aviso más sirve. El "hoy/mañana" lo pone la caja.
 */
export async function findUpcomingReservation(
  db: ArrivalDb,
  tenantId: string,
  plate: string,
  now: Date,
): Promise<
  (ArrivalCandidate & { classification: ArrivalClassification }) | null
> {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  const rows = await db.reservation.findMany({
    where: {
      tenantId,
      vehiclePlate: normalized,
      status: ReservationStatus.confirmed,
      entryAt: {
        gt: now,
        lte: new Date(now.getTime() + UPCOMING_LOOKAHEAD_MINUTES * 60_000),
      },
    },
    select: ARRIVAL_SELECT,
    orderBy: { entryAt: 'asc' },
  });
  if (rows.length === 0) return null;
  const fallback = await fallbackEarlyArrivalMax(db, tenantId, rows);
  for (const row of rows) {
    const classification = classifyArrival(row, now, fallback);
    if (classification.arrival === 'too_early') {
      return { ...row, classification };
    }
  }
  return null;
}

export type ArrivalLink = {
  reservationId: string;
  prepaidAmountArs: number;
  arrival: ArrivalKind;
  minutesEarly: number;
  minutesLate: number;
};

/**
 * Vincula un ingreso con su reserva: elige la candidata y la pasa a
 * `checked_in` con un `updateMany` guardado por el estado que se leyó. Si otro
 * ingreso (u otra transición) ganó la carrera, devuelve `null` y el ingreso se
 * registra igual, sin reserva: NUNCA se rechaza un ingreso por esto.
 *
 * Idempotente por construcción: una reserva ya `checked_in` no es vinculable,
 * así que un segundo ingreso de la misma patente no la vuelve a tomar.
 *
 * Desde la 6c vincula también las llegadas anticipadas (hasta el tope) y las
 * tardías (hasta `exitAt`); una `no_show` tardía vuelve a `checked_in`.
 */
export async function claimReservationForArrival(
  tx: ArrivalDb,
  input: {
    tenantId: string;
    plate: string;
    at: Date;
    reservationId?: string | null;
  },
): Promise<ArrivalLink | null> {
  const candidates = await findArrivalCandidates(
    tx,
    input.tenantId,
    input.plate,
    input.at,
  );
  if (candidates.length === 0) return null;
  const fallback = await fallbackEarlyArrivalMax(
    tx,
    input.tenantId,
    candidates,
  );
  const chosen = pickReservationForArrival(
    candidates,
    input.at,
    input.reservationId,
    fallback,
  );
  if (!chosen) return null;

  const claimed = await tx.reservation.updateMany({
    where: { id: chosen.id, tenantId: input.tenantId, status: chosen.status },
    data: { status: ReservationStatus.checked_in },
  });
  if (claimed.count === 0) return null;

  return {
    reservationId: chosen.id,
    prepaidAmountArs: prepaidAmountOf(chosen),
    arrival: chosen.classification.arrival,
    minutesEarly: chosen.classification.minutesEarly,
    minutesLate: chosen.classification.minutesLate,
  };
}

/**
 * La salida del auto cierra la reserva: `checked_in → completed`. Guardado por
 * estado, así que repetirlo no hace nada.
 */
export async function completeReservationForExit(
  tx: ReservationDb,
  tenantId: string,
  reservationId: string,
): Promise<boolean> {
  const completed = await tx.reservation.updateMany({
    where: {
      id: reservationId,
      tenantId,
      status: ReservationStatus.checked_in,
    },
    data: { status: ReservationStatus.completed },
  });
  return completed.count > 0;
}

/** Código corto que ve el operador y el conductor (R-XXXXXX). */
export function reservationCode(id: string): string {
  return `R-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}
