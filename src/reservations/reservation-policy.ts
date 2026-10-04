/**
 * Reglas puras del ciclo de vida de las reservas (sin Nest ni Prisma): qué
 * estados retienen lugar, la foto de las reglas de la playa y la vista previa
 * de una cancelación. Se testean sin base.
 */
import { ReservationStatus } from '@prisma/client';

/** Estados que ocupan un lugar del cupo (ver `countsAgainstQuota`). */
export const HOLDING_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.pending_payment,
  ReservationStatus.pending_approval,
  ReservationStatus.confirmed,
  ReservationStatus.checked_in,
];

/** Minutos que tiene el conductor para pagar una reserva nueva. */
export const HOLD_MINUTES = 10;

/**
 * Margen tras el fin de la retención en el que el cupo sigue tomado: un pago
 * en vuelo (el cliente ya pagó, el aviso todavía no llegó) no debería perder
 * el lugar por segundos.
 */
export const HOLD_GRACE_MS = 5 * 60_000;

export type AcceptanceMode = 'auto' | 'manual';

/** Reglas de la playa copiadas a la reserva al crearla. */
export type PolicySnapshot = {
  freeCancelMinutes: number;
  lateCancelRefundPct: number;
  earlyArrivalMinutes: number;
  graceMinutes: number;
  acceptanceMode: AcceptanceMode;
  approvalWindowMinutes: number;
  /**
   * Tope de la llegada anticipada (fase 6c): hasta cuántos minutos antes de
   * `entryAt` el ingreso se vincula solo ("llegó antes"). Las reservas
   * anteriores no lo tienen en el jsonb: para vincular usan el valor vivo del
   * servicio (ver `snapshotEarlyArrivalMax`); para mostrar, el default.
   */
  earlyArrivalMaxMinutes: number;
};

/** Defaults del producto, los mismos que las columnas de `services`. */
export const DEFAULT_POLICY_SNAPSHOT: PolicySnapshot = {
  freeCancelMinutes: 60,
  lateCancelRefundPct: 0,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  acceptanceMode: 'auto',
  approvalWindowMinutes: 15,
  earlyArrivalMaxMinutes: 60,
};

export function buildPolicySnapshot(service: {
  freeCancelMinutes: number;
  lateCancelRefundPct: number;
  earlyArrivalMinutes: number;
  graceMinutes: number;
  acceptanceMode: string;
  approvalWindowMinutes: number;
  earlyArrivalMaxMinutes: number;
}): PolicySnapshot {
  return {
    freeCancelMinutes: service.freeCancelMinutes,
    lateCancelRefundPct: service.lateCancelRefundPct,
    earlyArrivalMinutes: service.earlyArrivalMinutes,
    graceMinutes: service.graceMinutes,
    acceptanceMode: service.acceptanceMode === 'manual' ? 'manual' : 'auto',
    approvalWindowMinutes: service.approvalWindowMinutes,
    earlyArrivalMaxMinutes: service.earlyArrivalMaxMinutes,
  };
}

/**
 * Lee el `policy_snapshot` (jsonb) de una fila. Las reservas anteriores a la
 * migración lo tienen en NULL: caen en los defaults.
 */
export function readPolicySnapshot(raw: unknown): PolicySnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_POLICY_SNAPSHOT };
  }
  const value = raw as Record<string, unknown>;
  const num = (key: keyof PolicySnapshot, fallback: number) =>
    typeof value[key] === 'number' ? value[key] : fallback;
  return {
    freeCancelMinutes: num(
      'freeCancelMinutes',
      DEFAULT_POLICY_SNAPSHOT.freeCancelMinutes,
    ),
    lateCancelRefundPct: num(
      'lateCancelRefundPct',
      DEFAULT_POLICY_SNAPSHOT.lateCancelRefundPct,
    ),
    earlyArrivalMinutes: num(
      'earlyArrivalMinutes',
      DEFAULT_POLICY_SNAPSHOT.earlyArrivalMinutes,
    ),
    graceMinutes: num('graceMinutes', DEFAULT_POLICY_SNAPSHOT.graceMinutes),
    acceptanceMode: value.acceptanceMode === 'manual' ? 'manual' : 'auto',
    approvalWindowMinutes: num(
      'approvalWindowMinutes',
      DEFAULT_POLICY_SNAPSHOT.approvalWindowMinutes,
    ),
    earlyArrivalMaxMinutes: num(
      'earlyArrivalMaxMinutes',
      DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes,
    ),
  };
}

/**
 * El tope de llegada anticipada guardado en el snapshot, o `null` si la
 * reserva es anterior a la fase 6c y no lo tiene. Con `null`, el check-in usa
 * el valor vivo del servicio: el dueño lo configuró pensando en todas sus
 * reservas, y el default sólo existe para las playas que nunca lo tocaron.
 */
export function snapshotEarlyArrivalMax(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>).earlyArrivalMaxMinutes;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * ¿La reserva ocupa un lugar del cupo? Sí en `pending_approval`, `confirmed` y
 * `checked_in`; `pending_payment` sólo mientras su retención (más el margen de
 * `HOLD_GRACE_MS`) siga viva. Es la MISMA regla que `holdingWhere` expresa en
 * Prisma: si una cambia, cambia la otra.
 */
export function countsAgainstQuota(
  reservation: { status: ReservationStatus; holdExpiresAt: Date | null },
  now: Date,
): boolean {
  if (reservation.status === ReservationStatus.pending_payment) {
    return (
      reservation.holdExpiresAt !== null &&
      reservation.holdExpiresAt.getTime() + HOLD_GRACE_MS > now.getTime()
    );
  }
  return HOLDING_STATUSES.includes(reservation.status);
}

// ─── Cancelación ──────────────────────────────────────────────────────────────

export type CancelBy = 'driver' | 'owner';
export type RefundKind = 'full' | 'partial' | 'none';

export type CancelReasonCode =
  /** Antes del corte gratis: reembolso total. */
  | 'free_window'
  /** Entre el corte y el inicio: `lateCancelRefundPct`. */
  | 'late_window'
  /** Todavía sin aceptar: reembolso total. */
  | 'pending_approval'
  /** Todavía sin pagar: se cancela sin reembolso. */
  | 'not_paid'
  /** Cancela el dueño: reembolso total. */
  | 'owner'
  /** La reserva ya empezó. */
  | 'already_started'
  /** El estado no admite cancelación. */
  | 'not_cancellable';

export type CancelPreview = {
  allowed: boolean;
  refundArs: number;
  kind: RefundKind;
  reasonCode: CancelReasonCode;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const refundOf = (amountPaid: number, pct: number): number =>
  round2((amountPaid * pct) / 100);

const refusal = (reasonCode: CancelReasonCode): CancelPreview => ({
  allowed: false,
  refundArs: 0,
  kind: 'none',
  reasonCode,
});

function refundKind(refundArs: number, amountPaid: number): RefundKind {
  if (refundArs <= 0) return 'none';
  return refundArs >= amountPaid ? 'full' : 'partial';
}

/**
 * Vista previa de cancelar una reserva y de cuánto se reembolsa.
 *
 * - Conductor antes del corte (`entryAt − freeCancelMinutes`): reembolso total.
 * - Conductor entre el corte y el inicio: `lateCancelRefundPct` del pago.
 * - Conductor desde el inicio: no puede cancelar.
 * - Conductor en `pending_approval`: total (el dueño todavía no aceptó).
 * - Conductor en `pending_payment`: se cancela sin reembolso (no hay nada
 *   pagado).
 * - Dueño: siempre total. Sólo desde `pending_approval` o `confirmed`.
 *
 * `amountPaid` es lo efectivamente cobrado; el redondeo es a 2 decimales.
 */
export function cancelPreview(
  snapshot: PolicySnapshot,
  amountPaid: number,
  now: Date,
  entryAt: Date,
  status: ReservationStatus,
  by: CancelBy,
): CancelPreview {
  if (by === 'owner') {
    if (
      status !== ReservationStatus.pending_approval &&
      status !== ReservationStatus.confirmed
    ) {
      return refusal('not_cancellable');
    }
    const refundArs = round2(amountPaid);
    return {
      allowed: true,
      refundArs,
      kind: refundKind(refundArs, amountPaid),
      reasonCode: 'owner',
    };
  }

  if (status === ReservationStatus.pending_payment) {
    return {
      allowed: true,
      refundArs: 0,
      kind: 'none',
      reasonCode: 'not_paid',
    };
  }
  if (
    status !== ReservationStatus.pending_approval &&
    status !== ReservationStatus.confirmed
  ) {
    return refusal('not_cancellable');
  }
  if (now.getTime() >= entryAt.getTime()) return refusal('already_started');

  if (status === ReservationStatus.pending_approval) {
    const refundArs = round2(amountPaid);
    return {
      allowed: true,
      refundArs,
      kind: refundKind(refundArs, amountPaid),
      reasonCode: 'pending_approval',
    };
  }

  const cutoff = entryAt.getTime() - snapshot.freeCancelMinutes * 60_000;
  if (now.getTime() < cutoff) {
    const refundArs = round2(amountPaid);
    return {
      allowed: true,
      refundArs,
      kind: refundKind(refundArs, amountPaid),
      reasonCode: 'free_window',
    };
  }
  const refundArs = refundOf(amountPaid, snapshot.lateCancelRefundPct);
  return {
    allowed: true,
    refundArs,
    kind: refundKind(refundArs, amountPaid),
    reasonCode: 'late_window',
  };
}
