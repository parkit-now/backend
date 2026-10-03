/**
 * Check-in de reservas en la caja (fase 6): qué reserva corresponde a un auto
 * que llega, cuánto pagó por adelantado y las dos transiciones que dispara la
 * caja (`confirmed → checked_in` al ingresar, `checked_in → completed` al
 * salir).
 *
 * Las funciones de base reciben el cliente de la TRANSACCIÓN del ingreso o del
 * cierre: el vínculo y la estadía van juntos o no va ninguno. Por eso el
 * `tenantId` viaja explícito, igual que en `EntriesService` y en el ciclo de
 * vida.
 */
import {
  Prisma,
  ReservationPaymentStatus,
  ReservationStatus,
} from '@prisma/client';
import { normalizePlate } from '../driver/driver-rules';
import { readPolicySnapshot } from './reservation-policy';

/**
 * Topes de `services.early_arrival_minutes` y `services.grace_minutes` (CHECK
 * de la migración 20261003120000). Acotan la búsqueda en la base; la ventana
 * exacta de cada reserva sale de su `policySnapshot`.
 */
export const MAX_EARLY_ARRIVAL_MINUTES = 120;
export const MAX_GRACE_MINUTES = 180;

/**
 * Estados desde los que un ingreso puede vincularse.
 *
 * `no_show` entra a propósito: el sweeper lo pone apenas vence la tolerancia
 * sin ingreso, pero un ingreso hecho SIN CONEXIÓN dentro de la ventana recién
 * llega al servidor cuando la caja sincroniza. Si el auto entró a tiempo, la
 * reserva no fue un no-show. No mueve plata: el no-show no se reembolsa, así
 * que volver a `checked_in` sólo corrige el estado.
 */
export const LINKABLE_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.confirmed,
  ReservationStatus.no_show,
];

type WindowSource = {
  entryAt: Date;
  policySnapshot: unknown;
};

/**
 * Ventana de llegada de una reserva: `[entryAt − earlyArrival, entryAt +
 * grace]`, con las reglas que tenía la playa al reservar.
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

export function isWithinArrivalWindow(
  reservation: WindowSource,
  at: Date,
): boolean {
  const { from, until } = arrivalWindow(reservation);
  const ms = at.getTime();
  return ms >= from.getTime() && ms <= until.getTime();
}

/**
 * Rango de `entryAt` a buscar en la base para una llegada en `at`: cubre
 * cualquier ventana posible. El filtro fino lo hace `isWithinArrivalWindow`.
 */
export function arrivalSearchRange(at: Date): { gte: Date; lte: Date } {
  return {
    gte: new Date(at.getTime() - MAX_GRACE_MINUTES * 60_000),
    lte: new Date(at.getTime() + MAX_EARLY_ARRIVAL_MINUTES * 60_000),
  };
}

type Candidate = WindowSource & { id: string; status: ReservationStatus };

/**
 * La reserva que corresponde a un auto que llega en `at`, o `null`.
 *
 * Sólo cuentan las vinculables (`LINKABLE_STATUSES`) dentro de su ventana. Si
 * la caja eligió una (`preferredId`, la del banner) y sigue siendo válida,
 * gana esa. Si no, la de `entryAt` más cercana a la llegada (dos reservas de
 * la misma patente el mismo día, una a la mañana y otra a la tarde), y a
 * igual distancia la `confirmed` antes que la `no_show`.
 */
export function pickReservationForArrival<T extends Candidate>(
  candidates: readonly T[],
  at: Date,
  preferredId?: string | null,
): T | null {
  const eligible = candidates.filter(
    (candidate) =>
      LINKABLE_STATUSES.includes(candidate.status) &&
      isWithinArrivalWindow(candidate, at),
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

/**
 * `where` de las reservas vinculables de una patente cuya ventana puede
 * incluir `at`, o `null` si la patente no tiene nada utilizable.
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
    entryAt: arrivalSearchRange(at),
  };
}

/** Las reservas vinculables de una patente cuya ventana puede incluir `at`. */
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

export type ArrivalLink = {
  reservationId: string;
  prepaidAmountArs: number;
};

/**
 * Vincula un ingreso con su reserva: elige la candidata y la pasa a
 * `checked_in` con un `updateMany` guardado por el estado que se leyó. Si otro
 * ingreso (u otra transición) ganó la carrera, devuelve `null` y el ingreso se
 * registra igual, sin reserva: NUNCA se rechaza un ingreso por esto.
 *
 * Idempotente por construcción: una reserva ya `checked_in` no es vinculable,
 * así que un segundo ingreso de la misma patente no la vuelve a tomar.
 */
export async function claimReservationForArrival(
  tx: ReservationDb,
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
  const chosen = pickReservationForArrival(
    candidates,
    input.at,
    input.reservationId,
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
