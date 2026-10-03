/**
 * Requisitos para que una playa acepte reservas de conductores. Pura (sin Nest
 * ni Prisma): la usan `ServicesService` (bloquea la activación y se la muestra
 * al dueño) y `DriverService` (decide `acceptsReservations`), así las dos
 * miran exactamente lo mismo.
 */
import { MpAccountStatus } from '@prisma/client';

/** Mismo conjunto que `DriverVehicle.kind` (CHECK en driver_vehicles). */
export const RESERVATION_VEHICLE_KINDS = [
  'car',
  'suv_pickup',
  'motorcycle',
] as const;
export type ReservationVehicleKind = (typeof RESERVATION_VEHICLE_KINDS)[number];

export const RESERVATION_HOURS_MODES = ['opening', 'custom'] as const;
export type ReservationHoursMode = (typeof RESERVATION_HOURS_MODES)[number];

/** En el orden en que se muestran al dueño. */
export type ReservationRequirement =
  | 'mp_account'
  | 'spots'
  | 'hours'
  | 'vehicles'
  | 'rate';

export type ReservationReadiness = {
  ready: boolean;
  missing: ReservationRequirement[];
};

export type ReservationReadinessInput = {
  /** `null` = la playa no tiene cuenta de Mercado Pago. */
  mpStatus: MpAccountStatus | null;
  reservableSpots: number | null;
  /** Capacidad declarada; 0 = sin declarar (no hay contra qué comparar). */
  capacityTotal: number;
  /** La tarifa existe, está activa y no está borrada. */
  rateUsable: boolean;
  vehicleKinds: readonly string[];
  hoursMode: string;
  /** Filas de `schedules` (horario de apertura). */
  scheduleCount: number;
  /** Filas de `reservation_hours` (horario propio de reservas). */
  reservationHourCount: number;
};

export function computeReservationReadiness(
  input: ReservationReadinessInput,
): ReservationReadiness {
  const spots = input.reservableSpots ?? 0;
  const spotsOk =
    spots > 0 && (input.capacityTotal <= 0 || spots <= input.capacityTotal);
  const hoursOk =
    input.hoursMode === 'custom'
      ? input.reservationHourCount > 0
      : input.scheduleCount > 0;

  const checks: [ReservationRequirement, boolean][] = [
    ['mp_account', input.mpStatus === MpAccountStatus.linked],
    ['spots', spotsOk],
    ['hours', hoursOk],
    ['vehicles', input.vehicleKinds.length > 0],
    ['rate', input.rateUsable],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { ready: missing.length === 0, missing };
}
