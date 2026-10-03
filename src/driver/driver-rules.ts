/**
 * Reglas puras de la API del conductor (sin Nest ni Prisma), para testearlas
 * sin base: distancia, horarios en hora argentina y validación de la ventana
 * de una reserva. Las reservas se cotizan con la tarifa de reservas que elige
 * el dueño, la misma para cualquier vehículo.
 */
import { ReservationStatus, ScheduleDay } from '@prisma/client';
import {
  DEFAULT_TIME_ZONE,
  dayKeyIn,
  dayRangeIn,
  shiftDayKey,
} from '../metrics/metrics-tz';
import {
  countsAgainstQuota,
  readPolicySnapshot,
} from '../reservations/reservation-policy';

// ─── Distancia ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_METERS = 6_371_000;

export type Coordinate = { latitude: number; longitude: number };

export function distanceMeters(from: Coordinate, to: Coordinate): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLng = rad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) *
      Math.cos(rad(to.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Caja que contiene el círculo de búsqueda, para prefiltrar en la base con
 * índices comunes (sin PostGIS) antes de medir la distancia exacta.
 */
export function boundingBox(center: Coordinate, radiusMeters: number) {
  const latDelta = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const lngDelta =
    latDelta / Math.max(Math.cos((center.latitude * Math.PI) / 180), 0.01);
  return {
    minLat: center.latitude - latDelta,
    maxLat: center.latitude + latDelta,
    minLng: center.longitude - lngDelta,
    maxLng: center.longitude + lngDelta,
  };
}

// ─── Horarios ─────────────────────────────────────────────────────────────────

export type ScheduleRange = {
  day: ScheduleDay;
  openMinute: number;
  closeMinute: number;
};

// getUTCDay() de un DayKey: 0 = domingo.
const DAY_BY_INDEX: ScheduleDay[] = [
  ScheduleDay.sunday,
  ScheduleDay.monday,
  ScheduleDay.tuesday,
  ScheduleDay.wednesday,
  ScheduleDay.thursday,
  ScheduleDay.friday,
  ScheduleDay.saturday,
];

function weekdayOf(dayKey: string): ScheduleDay {
  const [year, month, day] = dayKey.split('-').map(Number);
  return DAY_BY_INDEX[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * Intervalos abiertos reales `[start, end)` entre `from` y `to`, en la zona de
 * la playa. Los rangos pegados se unen: un lote 24 h guarda 00:00–24:00 cada
 * día, y uno nocturno guarda 20:00–24:00 + 00:00–08:00 del día siguiente
 * (`close_minute` topea en 1440, ver schedules); los dos son continuos.
 */
export function openIntervals(
  schedules: ScheduleRange[],
  from: Date,
  to: Date,
  tz = DEFAULT_TIME_ZONE,
): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  const lastDay = dayKeyIn(to, tz);
  // Desde el día anterior: un rango de ayer hasta las 24:00 empalma con hoy.
  for (
    let dayKey = shiftDayKey(dayKeyIn(from, tz), -1);
    dayKey <= lastDay;
    dayKey = shiftDayKey(dayKey, 1)
  ) {
    const dayStart = dayRangeIn(dayKey, tz).gte.getTime();
    const weekday = weekdayOf(dayKey);
    for (const range of schedules) {
      if (range.day !== weekday) continue;
      intervals.push({
        start: dayStart + range.openMinute * 60_000,
        end: dayStart + range.closeMinute * 60_000,
      });
    }
  }

  intervals.sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * `true` si la playa está abierta durante TODO `[from, to]`: si cierra en el
 * medio, el auto queda adentro sin poder salir. Sin horarios cargados no se
 * puede saber: devuelve `null` y el caller decide.
 */
export function isOpenThroughout(
  schedules: ScheduleRange[],
  from: Date,
  to: Date,
  tz = DEFAULT_TIME_ZONE,
): boolean | null {
  if (schedules.length === 0) return null;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return openIntervals(schedules, from, to, tz).some(
    (interval) => interval.start <= fromMs && toMs <= interval.end,
  );
}

export function isOpenAt(
  schedules: ScheduleRange[],
  instant: Date,
  tz = DEFAULT_TIME_ZONE,
): boolean | null {
  return isOpenThroughout(schedules, instant, instant, tz);
}

// ─── Ventana de la reserva ────────────────────────────────────────────────────

export const RESERVATION_MAX_DAYS_AHEAD = 7;
export const RESERVATION_MAX_MINUTES = 24 * 60;
// Tolerancia para relojes de celular un poco atrasados.
const PAST_TOLERANCE_MS = 5 * 60_000;

export type WindowProblem =
  | 'exit_not_after_entry'
  | 'entry_in_past'
  | 'entry_too_far'
  | 'stay_too_long';

export function reservationWindowProblem(
  from: Date,
  to: Date,
  now: Date,
): WindowProblem | null {
  if (to.getTime() <= from.getTime()) return 'exit_not_after_entry';
  if (from.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return 'entry_in_past';
  }
  const limit = now.getTime() + RESERVATION_MAX_DAYS_AHEAD * 86_400_000;
  if (from.getTime() > limit) return 'entry_too_far';
  if (to.getTime() - from.getTime() > RESERVATION_MAX_MINUTES * 60_000) {
    return 'stay_too_long';
  }
  return null;
}

// ─── Reservas: cupo y disponibilidad (SCRUM-261, SCRUM-214) ──────────────────

/**
 * Una reserva deja de ocupar lugar `graceMinutes` después de su hora de
 * ingreso: o el auto ya entró (y cuenta como vehículo adentro) o no vino
 * (no-show). Cada playa lo configura (`services.grace_minutes`); este es el
 * default de la columna.
 */
export const DEFAULT_GRACE_MINUTES = 30;

export type ReservationWindow = { entryAt: Date; exitAt: Date };

export function windowsOverlap(
  left: ReservationWindow,
  right: ReservationWindow,
): boolean {
  return (
    left.entryAt.getTime() < right.exitAt.getTime() &&
    right.entryAt.getTime() < left.exitAt.getTime()
  );
}

/**
 * Máximo de reservas simultáneas dentro de `window`. No es la cantidad de
 * reservas que la tocan: 10–11 y 17–18 tocan una ventana de 10 a 18 pero nunca
 * coinciden, así que ocupan UNA plaza, no dos. Barrido por eventos; en el
 * mismo instante una salida libera antes de que entre la siguiente.
 */
export function peakConcurrentReservations(
  reservations: ReservationWindow[],
  window: ReservationWindow,
): number {
  const events: { at: number; delta: number }[] = [];
  for (const reservation of reservations) {
    if (!windowsOverlap(reservation, window)) continue;
    events.push({ at: reservation.entryAt.getTime(), delta: 1 });
    events.push({ at: reservation.exitAt.getTime(), delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/**
 * ¿Entra una reserva nueva? El cupo es `reservable_spots` de "Servicios →
 * Reservas" (SCRUM-214): plazas que se pueden reservar A LA VEZ. Entra si en
 * el momento más cargado de su ventana las reservas confirmadas siguen por
 * debajo del cupo. Los autos que entran sin reserva no lo consumen: el dueño
 * aparta esas plazas para reservas.
 */
export function hasReservationQuotaFor(
  reservableSpots: number,
  peakConcurrent: number,
): boolean {
  return peakConcurrent < reservableSpots;
}

/**
 * ¿La reserva retiene un lugar "ahora" para el conteo de disponibilidad? Sí si
 * cuenta contra el cupo (`countsAgainstQuota`: `pending_payment` con la
 * retención viva, `pending_approval`, `confirmed`), es de HOY (día civil en la
 * zona de la playa) y todavía no venció.
 *
 * `checked_in` NO retiene: la reserva aparta el lugar sólo hasta que el auto
 * entra, y desde ahí lo cuenta su ingreso (`entries` sin `leftAt`). Contarla
 * también sería el doble conteo: "Libres ahora" bajaría en 2 por un solo auto.
 * (Para el CUPO de reservas sí sigue contando: ver `holdingWhere`.)
 */
export function reservationHoldsSpotNow(
  reservation: {
    entryAt: Date;
    status: ReservationStatus;
    holdExpiresAt: Date | null;
  },
  now: Date,
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
  tz = DEFAULT_TIME_ZONE,
): boolean {
  if (reservation.status === ReservationStatus.checked_in) return false;
  if (!countsAgainstQuota(reservation, now)) return false;
  const expiresAt = reservation.entryAt.getTime() + graceMinutes * 60_000;
  return (
    dayKeyIn(reservation.entryAt, tz) === dayKeyIn(now, tz) &&
    now.getTime() < expiresAt
  );
}

/**
 * Reservas que retienen un lugar ahora (`reservationHoldsSpotNow`), cada una
 * con la tolerancia de su foto de reglas (la misma que usa el sweeper para el
 * no-show). Lo comparten la app del conductor y la métrica de ocupación, para
 * que "Libres ahora" diga lo mismo en todos lados.
 */
export function countReservedHeld(
  reservations: readonly {
    entryAt: Date;
    status: ReservationStatus;
    holdExpiresAt: Date | null;
    policySnapshot: unknown;
  }[],
  now: Date,
  tz = DEFAULT_TIME_ZONE,
): number {
  return reservations.filter((reservation) =>
    reservationHoldsSpotNow(
      reservation,
      now,
      readPolicySnapshot(reservation.policySnapshot).graceMinutes,
      tz,
    ),
  ).length;
}

/**
 * Lugares libres para el conductor: capacidad − adentro − reservas de hoy
 * vigentes. `null` si la playa no declaró capacidad (no se puede saber).
 */
export function availableSpots(
  capacity: number,
  occupiedNow: number,
  reservedToday: number,
): number | null {
  if (capacity <= 0) return null;
  return Math.max(capacity - occupiedNow - reservedToday, 0);
}

export type DriverReservationState = 'active' | 'completed' | 'cancelled';

/**
 * Estado que ve el conductor. Mapea los estados del ciclo de vida a los tres
 * que entiende la app: `pending_payment`, `pending_approval`, `confirmed` y
 * `checked_in` son `active`; `completed` y `no_show` son `completed`;
 * `cancelled`, `rejected` y `expired` son `cancelled`. Una reserva `confirmed`
 * cuyo egreso ya pasó se muestra `completed`; una `checked_in` sigue `active`
 * hasta que el auto sale (fase 6: la salida de la caja la completa).
 */
export function reservationState(
  status: ReservationStatus,
  exitAt: Date,
  now: Date,
): DriverReservationState {
  switch (status) {
    case ReservationStatus.cancelled:
    case ReservationStatus.rejected:
    case ReservationStatus.expired:
      return 'cancelled';
    case ReservationStatus.completed:
    case ReservationStatus.no_show:
      return 'completed';
    // Con el auto adentro la reserva sigue activa aunque se haya pasado de
    // `exitAt`: termina cuando sale (la caja la pasa a `completed`).
    case ReservationStatus.checked_in:
      return 'active';
    case ReservationStatus.confirmed:
      return exitAt.getTime() <= now.getTime() ? 'completed' : 'active';
    default:
      return 'active';
  }
}

/** Patente normalizada: mayúsculas, sin espacios ni guiones. */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
