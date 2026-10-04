import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ReservationPaymentStatus,
  ReservationStatus,
  ServiceCode,
  type Prisma,
  type Reservation,
} from '@prisma/client';
import { AuditActions } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { lockAndCheckCapacity } from './reservation-capacity';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from './payment-gateway/reservation-payment-gateway';
import {
  cancelPreview,
  countsAgainstQuota,
  HOLD_GRACE_MS,
  readPolicySnapshot,
  type CancelBy,
  type CancelPreview,
} from './reservation-policy';

const INSTANCE = '/reservations';

/** Estados terminales sin cobro previo: un pago que llega ahí se reembolsa. */
const UNPAID_TERMINAL_STATUSES: ReservationStatus[] = [
  ReservationStatus.cancelled,
  ReservationStatus.rejected,
  ReservationStatus.completed,
  ReservationStatus.no_show,
];
const MAX_REFUND_ERROR_LENGTH = 500;
/** El resumen del error que va a la auditoría es más corto que el de la fila. */
const MAX_AUDIT_ERROR_LENGTH = 200;

/** Quién hace la acción, para `cancelled_by_user_id` y la auditoría. */
export type ReservationActorRole =
  | 'owner'
  | 'operator'
  | 'admin'
  | 'driver'
  | 'system';

export type ReservationActor = {
  /** `null` cuando lo hace el sistema (sweeper, webhook, checkout de dev). */
  userId: string | null;
  role: ReservationActorRole;
};

export const SYSTEM_ACTOR: ReservationActor = { userId: null, role: 'system' };

/** El lado que se guarda en `cancelled_by`: dueño y operador son "owner". */
function sideOf(actor: ReservationActor): 'driver' | 'owner' | 'system' {
  if (actor.role === 'driver') return 'driver';
  if (actor.role === 'system') return 'system';
  return 'owner';
}

type AuditDb = Pick<Prisma.TransactionClient, 'auditLog'>;

/** Datos del pago que reporta el proveedor (o el checkout de dev). */
export type ProviderPaymentRef = {
  providerPaymentId: string;
  providerStatus?: string;
  providerStatusDetail?: string;
};

export type TransitionResult = {
  /** `false`: nada cambió (la transición ya estaba aplicada o no correspondía). */
  changed: boolean;
  reservation: Reservation;
};

export type MarkPaidOutcome =
  | 'confirmed'
  | 'pending_approval'
  /** Pago tardío sin cupo: se reembolsó todo y la reserva quedó `expired`. */
  | 'refunded_no_capacity'
  /**
   * El pago llegó cuando la reserva ya estaba cancelada, rechazada, completada
   * o en no-show sin haber cobrado nunca: se registra y se reembolsa todo, sin
   * tocar el estado de la reserva.
   */
  | 'refunded_after_cancel'
  /** La reserva ya no estaba esperando el pago: no se tocó. */
  | 'ignored';

export type ConfirmRefundOutcome =
  | 'refunded'
  | 'partial'
  /** Ya estaba confirmado (o no estaba pendiente): no se tocó. */
  | 'ignored'
  /** Nadie pidió el reembolso (se hizo desde el panel del proveedor). */
  | 'ignored_unrequested';

export type ConfirmRefundResult = TransitionResult & {
  outcome: ConfirmRefundOutcome;
};

export type MarkPaidResult = TransitionResult & { outcome: MarkPaidOutcome };

/**
 * Ciclo de vida de la reserva con pago. TODAS las transiciones son
 * `updateMany where { id, tenantId, status }`: el primero que llega gana y el
 * segundo actualiza 0 filas y se entera por el `count`. Eso las hace
 * idempotentes (el webhook, el sweeper y el dueño pueden pisarse).
 *
 * - Las que dispara un actor (`accept`, `reject`, `ownerCancel`,
 *   `driverCancel`, `retryRefund`) responden 409 si el estado no corresponde.
 * - Las que dispara el sistema (`markPaid`, `markPaymentRejected`, y las del
 *   sweeper) no tiran: devuelven si cambiaron algo.
 *
 * El reembolso se pide SIEMPRE por `startRefund`, que lo registra antes de
 * llamar al proveedor: si la llamada falla queda `failed` con el motivo, a la
 * espera del reintento manual del dueño.
 */
@Injectable()
export class ReservationLifecycleService {
  private readonly logger = new Logger(ReservationLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESERVATION_PAYMENT_GATEWAY)
    private readonly gateway: ReservationPaymentGateway,
  ) {}

  /**
   * Vista previa de cancelar. Lo que se cobró es el total salvo en
   * `pending_payment`, donde todavía no hay nada pagado.
   */
  previewCancel(
    reservation: Reservation,
    by: CancelBy,
    now = new Date(),
  ): CancelPreview {
    const amountPaid =
      reservation.status === ReservationStatus.pending_payment
        ? 0
        : Number(reservation.totalArs);
    return cancelPreview(
      readPolicySnapshot(reservation.policySnapshot),
      amountPaid,
      now,
      reservation.entryAt,
      reservation.status,
      by,
    );
  }

  // ─── Pago ───────────────────────────────────────────────────────────────────

  /**
   * El proveedor confirmó el pago. Con la retención viva la reserva pasa a
   * `confirmed` (modo `auto`) o a `pending_approval` (modo `manual`, con
   * `approvalDeadlineAt`). Si la retención ya venció o la reserva ya estaba
   * `expired` (pago tardío), se vuelve a contar el cupo bajo el lock de la
   * playa, sin contarse a sí misma: con lugar se confirma igual; sin lugar se
   * reembolsa todo, `cancelledBy = system` y `reason = late_payment_no_capacity`.
   *
   * Idempotente: sobre una reserva que ya cobró (`paidAt`) o que no espera el
   * pago, no hace nada.
   */
  async markPaid(
    reservationId: string,
    payment: ProviderPaymentRef,
    now = new Date(),
  ): Promise<MarkPaidResult> {
    const reservation = await this.load({ id: reservationId }, INSTANCE);
    if (
      reservation.paidAt === null &&
      UNPAID_TERMINAL_STATUSES.includes(reservation.status)
    ) {
      return this.refundLatePayment(reservation, payment, now);
    }
    const waiting =
      reservation.status === ReservationStatus.pending_payment ||
      reservation.status === ReservationStatus.expired;
    if (!waiting || reservation.paidAt !== null) {
      return { changed: false, outcome: 'ignored', reservation };
    }

    const policy = readPolicySnapshot(reservation.policySnapshot);
    const manual = policy.acceptanceMode === 'manual';
    const accepted: Prisma.ReservationUpdateManyMutationInput = {
      status: manual
        ? ReservationStatus.pending_approval
        : ReservationStatus.confirmed,
      paidAt: now,
      approvalDeadlineAt: manual
        ? new Date(now.getTime() + policy.approvalWindowMinutes * 60_000)
        : null,
    };
    const outcome: MarkPaidOutcome = manual ? 'pending_approval' : 'confirmed';
    const { tenantId } = reservation;
    const from = reservation.status;

    // Retención viva (con su margen): el cupo sigue tomado, no hay que recontar.
    if (countsAgainstQuota(reservation, now)) {
      const updated = await this.prisma.reservation.updateMany({
        where: { id: reservation.id, tenantId, status: from },
        data: accepted,
      });
      if (updated.count === 0) {
        return { changed: false, outcome: 'ignored', reservation };
      }
      await this.approvePayment(reservation, payment, now);
      return {
        changed: true,
        outcome,
        reservation: await this.reload(reservation.id),
      };
    }

    // Pago tardío: recontar el cupo, excluyendo a la propia reserva.
    const hadRoom = await this.prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({
        where: { tenantId, code: ServiceCode.ADVANCE_RESERVATION },
        select: { reservableSpots: true },
      });
      const room = await lockAndCheckCapacity(
        tx,
        tenantId,
        { entryAt: reservation.entryAt, exitAt: reservation.exitAt },
        service?.reservableSpots ?? 0,
        now,
        reservation.id,
      );
      const updated = await tx.reservation.updateMany({
        where: { id: reservation.id, tenantId, status: from },
        data: room
          ? accepted
          : {
              status: ReservationStatus.expired,
              paidAt: now,
              cancelledAt: now,
              cancelledBy: 'system',
              reason: 'late_payment_no_capacity',
            },
      });
      if (updated.count === 0) return null;
      if (!room) {
        await this.audit(tx, {
          action: AuditActions.RESERVATION_LATE_PAYMENT_REFUNDED,
          reservation,
          actor: SYSTEM_ACTOR,
          extra: {
            reasonCode: 'late_payment_no_capacity',
            refundArs: Number(reservation.totalArs),
            refundStatus: 'pending',
          },
        });
      }
      return room;
    });
    if (hadRoom === null) {
      return { changed: false, outcome: 'ignored', reservation };
    }

    await this.approvePayment(reservation, payment, now);
    if (!hadRoom) {
      await this.startRefund(
        reservation,
        Number(reservation.totalArs),
        now,
        SYSTEM_ACTOR,
      );
    }
    return {
      changed: true,
      outcome: hadRoom ? outcome : 'refunded_no_capacity',
      reservation: await this.reload(reservation.id),
    };
  }

  /**
   * Pago aprobado sobre una reserva terminal que nunca cobró (el conductor
   * canceló en `pending_payment` y el pago igual se aprobó): se registra el
   * pago (`paidAt` es el guard de idempotencia), se reembolsa el total y el
   * estado de la reserva no cambia.
   */
  private async refundLatePayment(
    reservation: Reservation,
    payment: ProviderPaymentRef,
    now: Date,
  ): Promise<MarkPaidResult> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          tenantId: reservation.tenantId,
          status: reservation.status,
          paidAt: null,
        },
        data: { paidAt: now },
      });
      if (result.count === 0) return false;
      await this.audit(tx, {
        action: AuditActions.RESERVATION_LATE_PAYMENT_REFUNDED,
        reservation,
        actor: SYSTEM_ACTOR,
        extra: {
          reasonCode: 'payment_after_cancel',
          refundArs: Number(reservation.totalArs),
          refundStatus: 'pending',
        },
      });
      return true;
    });
    if (!claimed) {
      return { changed: false, outcome: 'ignored', reservation };
    }
    await this.approvePayment(reservation, payment, now);
    await this.startRefund(
      reservation,
      Number(reservation.totalArs),
      now,
      SYSTEM_ACTOR,
    );
    return {
      changed: true,
      outcome: 'refunded_after_cancel',
      reservation: await this.reload(reservation.id),
    };
  }

  /**
   * El proveedor rechazó el pago. El pago pasa a `rejected` y la reserva SIGUE
   * en `pending_payment`: mientras dure la retención el conductor puede
   * reintentar con otro medio.
   */
  async markPaymentRejected(
    reservationId: string,
    payment: Partial<ProviderPaymentRef> = {},
  ): Promise<TransitionResult> {
    const reservation = await this.load({ id: reservationId }, INSTANCE);
    if (reservation.status !== ReservationStatus.pending_payment) {
      return { changed: false, reservation };
    }
    const updated = await this.prisma.reservationPayment.updateMany({
      where: {
        reservationId,
        tenantId: reservation.tenantId,
        status: ReservationPaymentStatus.created,
      },
      data: {
        status: ReservationPaymentStatus.rejected,
        providerPaymentId: payment.providerPaymentId,
        providerStatus: payment.providerStatus ?? 'rejected',
        providerStatusDetail: payment.providerStatusDetail,
      },
    });
    return { changed: updated.count > 0, reservation };
  }

  /**
   * El proveedor confirmó (webhook o sweeper) un reembolso. De `pending` o
   * `failed` pasa a `refunded` (si alcanza el total de la reserva) o `partial`,
   * guarda el monto, limpia el error y deja la fila de pago en
   * `refunded|partially_refunded`. Guardado por estado: un segundo aviso no
   * cambia nada (`ignored`).
   *
   * Si nadie pidió el reembolso (`refundStatus = none`: el dueño devolvió desde
   * el panel de Mercado Pago) la reserva no se toca: sólo se actualiza el
   * estado del proveedor en la fila de pago (`ignored_unrequested`).
   */
  async confirmRefund(
    reservationId: string,
    refund: { refundedAmountArs: number; providerPaymentId?: string },
    now = new Date(),
  ): Promise<ConfirmRefundResult> {
    const reservation = await this.load({ id: reservationId }, INSTANCE);
    const { tenantId } = reservation;
    const full = refund.refundedAmountArs >= Number(reservation.totalArs);
    const paymentStatus = full
      ? ReservationPaymentStatus.refunded
      : ReservationPaymentStatus.partially_refunded;
    const paymentWhere = {
      reservationId,
      tenantId,
      ...(refund.providerPaymentId
        ? { providerPaymentId: refund.providerPaymentId }
        : { providerPaymentId: { not: null } }),
    };

    if (reservation.refundStatus === 'none') {
      this.logger.warn(
        `Refund of ${refund.refundedAmountArs} ARS for reservation ${reservationId} was not requested by Parkit (refunded from the provider panel?).`,
      );
      await this.prisma.reservationPayment.updateMany({
        where: paymentWhere,
        data: { providerStatus: paymentStatus },
      });
      return { changed: false, outcome: 'ignored_unrequested', reservation };
    }

    const refundStatus = full ? 'refunded' : 'partial';
    const confirmed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: {
          id: reservationId,
          tenantId,
          refundStatus: { in: ['pending', 'failed'] },
        },
        data: {
          refundStatus,
          refundedAmountArs: refund.refundedAmountArs,
          refundError: null,
        },
      });
      if (updated.count === 0) return false;
      await tx.reservationPayment.updateMany({
        where: paymentWhere,
        data: { status: paymentStatus, providerStatus: paymentStatus },
      });
      await this.audit(tx, {
        action: AuditActions.RESERVATION_REFUND_CONFIRMED,
        reservation,
        actor: SYSTEM_ACTOR,
        extra: {
          refundArs: refund.refundedAmountArs,
          refundStatus,
          previousRefundStatus: reservation.refundStatus,
        },
      });
      return true;
    });
    if (!confirmed) return { changed: false, outcome: 'ignored', reservation };
    this.logger.log(
      `Refund confirmed for reservation ${reservationId}: ${refundStatus} (${refund.refundedAmountArs} ARS) at ${now.toISOString()}`,
    );
    return {
      changed: true,
      outcome: refundStatus,
      reservation: await this.reload(reservationId),
    };
  }

  /**
   * Deja `failed` un reembolso `pending` que el sistema no pudo confirmar (por
   * ejemplo, el token del dueño venció o se revocó). Guardado por estado: si ya
   * no está `pending` no hace nada. Lo audita (`warn`) como el sistema.
   */
  async markRefundFailedBySystem(
    reservationId: string,
    tenantId: string,
    message: string,
  ): Promise<TransitionResult> {
    const reservation = await this.load(
      { id: reservationId, tenantId },
      INSTANCE,
    );
    const error = message.slice(0, MAX_REFUND_ERROR_LENGTH);
    const changed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: { id: reservationId, tenantId, refundStatus: 'pending' },
        data: { refundStatus: 'failed', refundError: error },
      });
      if (updated.count === 0) return false;
      await this.audit(tx, {
        action: AuditActions.RESERVATION_REFUND_FAILED,
        reservation,
        actor: SYSTEM_ACTOR,
        severity: 'warn',
        extra: {
          refundArs: Number(reservation.refundRequestedArs ?? 0),
          refundStatus: 'failed',
          refundError: error.slice(0, MAX_AUDIT_ERROR_LENGTH),
        },
      });
      return true;
    });
    return {
      changed,
      reservation: changed ? await this.reload(reservationId) : reservation,
    };
  }

  // ─── Acciones del dueño ─────────────────────────────────────────────────────

  /**
   * Acepta una reserva `pending_approval`. Si el dueño ya se pasó de
   * `approvalDeadlineAt`, se aplica el vencimiento (rechazo del sistema con
   * reembolso total) y responde 409 `RESERVATION_APPROVAL_EXPIRED`.
   */
  async accept(
    tenantId: string,
    reservationId: string,
    actor: ReservationActor,
    now = new Date(),
  ): Promise<TransitionResult> {
    const instance = `/tenants/${tenantId}/reservations/${reservationId}/accept`;
    const reservation = await this.load(
      { id: reservationId, tenantId },
      instance,
    );
    if (reservation.status !== ReservationStatus.pending_approval) {
      throw notPendingApproval(instance);
    }
    if (
      reservation.approvalDeadlineAt !== null &&
      reservation.approvalDeadlineAt.getTime() < now.getTime()
    ) {
      await this.rejectByTimeout(reservation.id, tenantId, now);
      throw failure(
        HttpStatus.CONFLICT,
        'The approval window expired; the reservation was rejected.',
        instance,
        ErrorCodes.RESERVATION_APPROVAL_EXPIRED,
      );
    }
    const accepted = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          tenantId,
          status: ReservationStatus.pending_approval,
        },
        data: { status: ReservationStatus.confirmed },
      });
      if (updated.count === 0) return false;
      await this.audit(tx, {
        action: AuditActions.RESERVATION_ACCEPTED,
        reservation,
        actor,
      });
      return true;
    });
    if (!accepted) throw notPendingApproval(instance);
    return { changed: true, reservation: await this.reload(reservation.id) };
  }

  /** Rechaza una `pending_approval`: reembolso total. */
  async reject(
    tenantId: string,
    reservationId: string,
    reason: string,
    actor: ReservationActor,
    now = new Date(),
  ): Promise<TransitionResult> {
    const instance = `/tenants/${tenantId}/reservations/${reservationId}/reject`;
    assertReason(reason, instance);
    const reservation = await this.load(
      { id: reservationId, tenantId },
      instance,
    );
    if (reservation.status !== ReservationStatus.pending_approval) {
      throw notPendingApproval(instance);
    }
    const rejected = await this.cancelAndRefund(reservation, {
      to: ReservationStatus.rejected,
      actor,
      reason: reason.trim(),
      refundArs: Number(reservation.totalArs),
      now,
    });
    if (!rejected) throw notPendingApproval(instance);
    return { changed: true, reservation: rejected };
  }

  /** El dueño cancela una `pending_approval` o `confirmed`: reembolso total. */
  async ownerCancel(
    tenantId: string,
    reservationId: string,
    reason: string,
    actor: ReservationActor,
    now = new Date(),
  ): Promise<TransitionResult> {
    const instance = `/tenants/${tenantId}/reservations/${reservationId}/cancel`;
    assertReason(reason, instance);
    const reservation = await this.load(
      { id: reservationId, tenantId },
      instance,
    );
    const preview = this.previewCancel(reservation, 'owner', now);
    if (!preview.allowed) throw notCancellable(instance);
    const cancelled = await this.cancelAndRefund(reservation, {
      to: ReservationStatus.cancelled,
      actor,
      reason: reason.trim(),
      refundArs: preview.refundArs,
      now,
    });
    if (!cancelled) throw notCancellable(instance);
    return { changed: true, reservation: cancelled };
  }

  /**
   * Reintenta un reembolso `failed` (a mano: el sweeper no los reintenta). Usa
   * el monto que se había pedido y una `idempotencyKey` nueva.
   */
  async retryRefund(
    tenantId: string,
    reservationId: string,
    actor: ReservationActor,
    now = new Date(),
  ): Promise<TransitionResult> {
    const instance = `/tenants/${tenantId}/reservations/${reservationId}/refund/retry`;
    const reservation = await this.load(
      { id: reservationId, tenantId },
      instance,
    );
    const notRetryable = () =>
      failure(
        HttpStatus.CONFLICT,
        'Only a failed refund can be retried.',
        instance,
        ErrorCodes.RESERVATION_REFUND_NOT_RETRYABLE,
      );
    if (reservation.refundStatus !== 'failed') throw notRetryable();

    // Toma el reintento: dos pedidos a la vez no mandan dos reembolsos.
    const refundArs = Number(
      reservation.refundRequestedArs ?? reservation.totalArs,
    );
    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.reservation.updateMany({
        where: { id: reservation.id, tenantId, refundStatus: 'failed' },
        data: { refundStatus: 'pending' },
      });
      if (result.count === 0) return false;
      await this.audit(tx, {
        action: AuditActions.RESERVATION_REFUND_RETRIED,
        reservation,
        actor,
        extra: {
          refundArs,
          refundStatus: 'pending',
          attempt: reservation.refundAttempts + 1,
        },
      });
      return true;
    });
    if (!claimed) throw notRetryable();

    await this.startRefund(reservation, refundArs, now, actor);
    return { changed: true, reservation: await this.reload(reservation.id) };
  }

  // ─── Acción del conductor ───────────────────────────────────────────────────

  /**
   * El conductor cancela su reserva según la política (`cancelPreview`). En
   * `pending_payment` se invalida el checkout y no hay reembolso.
   */
  async driverCancel(
    userId: string,
    reservationId: string,
    now = new Date(),
  ): Promise<TransitionResult> {
    const instance = `/driver/reservations/${reservationId}/cancel`;
    const reservation = await this.load(
      { id: reservationId, userId },
      instance,
    );
    const preview = this.previewCancel(reservation, 'driver', now);
    if (!preview.allowed) throw notCancellable(instance);
    const cancelled = await this.cancelAndRefund(reservation, {
      to: ReservationStatus.cancelled,
      actor: { userId, role: 'driver' },
      reason: null,
      refundArs: preview.refundArs,
      now,
    });
    if (!cancelled) throw notCancellable(instance);
    return { changed: true, reservation: cancelled };
  }

  // ─── Transiciones del sweeper ───────────────────────────────────────────────

  /** `pending_payment` con la retención (+5 min) vencida pasa a `expired`. */
  async expireHold(
    reservationId: string,
    tenantId: string,
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.prisma.reservation.updateMany({
      where: {
        id: reservationId,
        tenantId,
        status: ReservationStatus.pending_payment,
        holdExpiresAt: { lt: new Date(now.getTime() - HOLD_GRACE_MS) },
      },
      data: { status: ReservationStatus.expired, reason: 'hold_expired' },
    });
    if (updated.count === 0) return false;
    await this.cancelUnpaidCheckout(reservationId, tenantId);
    return true;
  }

  /**
   * `pending_approval` con `approvalDeadlineAt` vencido pasa a `rejected` por el
   * sistema (`approval_timeout`), con reembolso total.
   */
  async rejectByTimeout(
    reservationId: string,
    tenantId: string,
    now = new Date(),
  ): Promise<boolean> {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, tenantId },
    });
    if (
      !reservation ||
      reservation.status !== ReservationStatus.pending_approval ||
      reservation.approvalDeadlineAt === null ||
      reservation.approvalDeadlineAt.getTime() >= now.getTime()
    ) {
      return false;
    }
    const rejected = await this.cancelAndRefund(reservation, {
      to: ReservationStatus.rejected,
      actor: SYSTEM_ACTOR,
      reasonCode: 'approval_timeout',
      refundArs: Number(reservation.totalArs),
      now,
    });
    return rejected !== null;
  }

  /** `confirmed` cuya tolerancia venció sin ingreso pasa a `no_show`. */
  async markNoShow(
    reservationId: string,
    tenantId: string,
    now = new Date(),
  ): Promise<boolean> {
    const updated = await this.prisma.reservation.updateMany({
      where: {
        id: reservationId,
        tenantId,
        status: ReservationStatus.confirmed,
        entryAt: { lt: now },
      },
      data: { status: ReservationStatus.no_show },
    });
    return updated.count > 0;
  }

  /**
   * Red de seguridad de la salida: una `checked_in` cuyo ingreso ya cerró pasa
   * a `completed`. Lo normal es que lo haga el cierre de la estadía en su
   * misma transacción (`completeReservationForExit`); esto cubre un cierre
   * que entró por un backend que todavía no lo hacía (deploy en curso o
   * rollback). Guardado por estado: idempotente.
   */
  async markCompleted(
    reservationId: string,
    tenantId: string,
  ): Promise<boolean> {
    const updated = await this.prisma.reservation.updateMany({
      where: {
        id: reservationId,
        tenantId,
        status: ReservationStatus.checked_in,
      },
      data: { status: ReservationStatus.completed },
    });
    return updated.count > 0;
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private async load(
    where: { id: string; tenantId?: string; userId?: string },
    instance: string,
  ): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findFirst({ where });
    if (!reservation) {
      throw failure(
        HttpStatus.NOT_FOUND,
        'Reservation not found.',
        instance,
        ErrorCodes.RESERVATION_NOT_FOUND,
      );
    }
    return reservation;
  }

  private async reload(id: string): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id },
    });
    if (!reservation) {
      throw failure(
        HttpStatus.NOT_FOUND,
        'Reservation not found.',
        INSTANCE,
        ErrorCodes.RESERVATION_NOT_FOUND,
      );
    }
    return reservation;
  }

  /**
   * Marca aprobado el pago de la reserva (también uno vencido por el sweeper o
   * rechazado: en Checkout Pro el comprador reintenta en la MISMA preferencia y
   * el segundo pago puede salir aprobado después de un rechazo).
   *
   * Elige la fila cuyo `providerPaymentId` coincide con el que llega y, si no
   * hay, la última de la reserva que todavía no está aprobada. Si la elegida no
   * está viva (`created`), cancela antes cualquier otra `created` de la reserva
   * en la misma transacción: el índice único parcial sólo admite una fila viva.
   * Idempotente: si la fila ya está aprobada (o devuelta) no la toca.
   */
  private async approvePayment(
    reservation: Reservation,
    payment: ProviderPaymentRef,
    now: Date,
  ): Promise<void> {
    const { id: reservationId, tenantId } = reservation;
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.reservationPayment.findMany({
        where: { reservationId, tenantId },
        orderBy: { createdAt: 'desc' },
      });
      const open: ReservationPaymentStatus[] = [
        ReservationPaymentStatus.created,
        ReservationPaymentStatus.cancelled,
        ReservationPaymentStatus.rejected,
      ];
      const target =
        rows.find(
          (row) => row.providerPaymentId === payment.providerPaymentId,
        ) ?? rows.find((row) => open.includes(row.status));
      if (!target || !open.includes(target.status)) return;

      if (target.status !== ReservationPaymentStatus.created) {
        await tx.reservationPayment.updateMany({
          where: {
            reservationId,
            tenantId,
            status: ReservationPaymentStatus.created,
          },
          data: { status: ReservationPaymentStatus.cancelled },
        });
      }
      await tx.reservationPayment.updateMany({
        where: { id: target.id, status: { in: open } },
        data: {
          status: ReservationPaymentStatus.approved,
          providerPaymentId: payment.providerPaymentId,
          providerStatus: payment.providerStatus ?? 'approved',
          providerStatusDetail: payment.providerStatusDetail,
          approvedAt: now,
        },
      });
    });
  }

  /**
   * Cancela o rechaza la reserva (`updateMany` guardado por el estado que se
   * leyó) y se ocupa del dinero: en `pending_payment` invalida el checkout (no
   * hay nada que devolver); en el resto pide el reembolso. Devuelve `null` si
   * otro actor la movió antes.
   */
  private async cancelAndRefund(
    reservation: Reservation,
    options: {
      to: 'cancelled' | 'rejected';
      actor: ReservationActor;
      /** Motivo que escribió la persona. */
      reason?: string | null;
      /** Motivo fijo del sistema (se guarda en `reason` si no hay otro). */
      reasonCode?: string;
      refundArs: number;
      now: Date;
    },
  ): Promise<Reservation | null> {
    const { tenantId } = reservation;
    const { actor } = options;
    // Sin cobro previo (`pending_payment`) o de camino viejo (`paidAt` null)
    // no hay nada que devolver.
    const refunds =
      reservation.status !== ReservationStatus.pending_payment &&
      reservation.paidAt !== null &&
      options.refundArs > 0;
    const done = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: { id: reservation.id, tenantId, status: reservation.status },
        data: {
          status: options.to,
          cancelledAt: options.now,
          cancelledBy: sideOf(actor),
          cancelledByUserId: actor.userId,
          reason: options.reason ?? options.reasonCode ?? null,
        },
      });
      if (updated.count === 0) return false;
      await this.audit(tx, {
        action:
          options.to === 'rejected'
            ? AuditActions.RESERVATION_REJECTED
            : AuditActions.RESERVATION_CANCELLED,
        reservation,
        actor,
        // Cancelar desde el estacionamiento (dueño/operador/admin) es una
        // acción a revisar; el rechazo manual y las del conductor/sistema no.
        severity:
          options.to === 'cancelled' && sideOf(actor) === 'owner'
            ? 'warn'
            : 'info',
        extra: {
          reason: options.reason ?? undefined,
          reasonCode: options.reasonCode,
          refundArs: refunds ? options.refundArs : 0,
          refundStatus: refunds ? 'pending' : 'none',
        },
      });
      return true;
    });
    if (!done) return null;

    if (reservation.status === ReservationStatus.pending_payment) {
      await this.cancelUnpaidCheckout(reservation.id, tenantId);
    } else {
      await this.startRefund(
        reservation,
        options.refundArs,
        options.now,
        actor,
      );
    }
    return this.reload(reservation.id);
  }

  /** Invalida el checkout de una reserva que no llegó a pagarse. */
  private async cancelUnpaidCheckout(
    reservationId: string,
    tenantId: string,
  ): Promise<void> {
    const payment = await this.prisma.reservationPayment.findFirst({
      where: {
        reservationId,
        tenantId,
        status: ReservationPaymentStatus.created,
      },
    });
    if (!payment) return;
    try {
      await this.gateway.cancelPending({
        tenantId,
        reservationId,
        providerPreferenceId: payment.providerPreferenceId,
      });
    } catch (error) {
      // No bloquea la cancelación: el checkout igual vence solo.
      this.logger.warn(
        `cancelPending failed for reservation ${reservationId}: ${describe(error)}`,
      );
    }
    await this.prisma.reservationPayment.updateMany({
      where: { id: payment.id, status: ReservationPaymentStatus.created },
      data: { status: ReservationPaymentStatus.cancelled },
    });
  }

  /**
   * Pide el reembolso: registra `pending` (y cuenta el intento) ANTES de llamar
   * al proveedor, para que un corte a mitad de camino no deje la reserva sin
   * rastro. Con 0 $ (o si nunca hubo un cobro) no llama a nadie y el
   * `refundStatus` queda `none`.
   *
   * - El proveedor lo confirma (`refunded`): `refunded` (o `partial` si no es el
   *   total) con `refundedAmountArs`.
   * - Lo acepta pero sin confirmar (`pending`): queda `pending` hasta el
   *   webhook (fase 3).
   * - Tira: `failed` con `refundError`; el dueño lo reintenta a mano.
   */
  private async startRefund(
    reservation: Reservation,
    amountArs: number,
    now: Date,
    actor: ReservationActor,
  ): Promise<void> {
    if (amountArs <= 0) return;
    const { id, tenantId } = reservation;

    const payment = await this.prisma.reservationPayment.findFirst({
      where: { reservationId: id, tenantId, providerPaymentId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    // Camino viejo (fuera de producción): la reserva nació `confirmed` sin pasar
    // por el checkout, así que no se cobró nada y no hay nada que devolver.
    if (!payment && !reservation.paidAt) return;
    const { refundAttempts } = await this.prisma.reservation.update({
      where: { id },
      data: {
        refundStatus: 'pending',
        refundAttempts: { increment: 1 },
        refundRequestedAt: now,
        refundRequestedArs: amountArs,
        refundError: null,
      },
      select: { refundAttempts: true },
    });

    if (!payment?.providerPaymentId) {
      await this.markRefundFailed(
        reservation,
        amountArs,
        'No approved payment to refund.',
        actor,
      );
      return;
    }

    let result: Awaited<ReturnType<ReservationPaymentGateway['refund']>>;
    try {
      result = await this.gateway.refund({
        tenantId,
        providerPaymentId: payment.providerPaymentId,
        amountArs,
        idempotencyKey: `refund:${id}:${refundAttempts}`,
      });
    } catch (error) {
      this.logger.warn(
        `Refund failed for reservation ${id} (attempt ${refundAttempts}): ${describe(error)}`,
      );
      await this.markRefundFailed(
        reservation,
        amountArs,
        describe(error),
        actor,
      );
      return;
    }

    if (result.status !== 'refunded') return;
    const full = result.amountArs >= Number(reservation.totalArs);
    await this.prisma.reservation.update({
      where: { id },
      data: {
        refundStatus: full ? 'refunded' : 'partial',
        refundedAmountArs: result.amountArs,
      },
    });
    await this.prisma.reservationPayment.updateMany({
      where: { id: payment.id },
      data: {
        status: full
          ? ReservationPaymentStatus.refunded
          : ReservationPaymentStatus.partially_refunded,
      },
    });
  }

  /** Deja el reembolso `failed` y lo audita (`warn`) en la misma transacción. */
  private async markRefundFailed(
    reservation: Reservation,
    amountArs: number,
    error: string,
    actor: ReservationActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          refundStatus: 'failed',
          refundError: error.slice(0, MAX_REFUND_ERROR_LENGTH),
        },
      });
      // No es una transición: `previousStatus` es el estado en que está ahora.
      await this.audit(tx, {
        action: AuditActions.RESERVATION_REFUND_FAILED,
        reservation: { ...reservation, status: current.status },
        actor,
        severity: 'warn',
        extra: {
          refundArs: amountArs,
          refundStatus: 'failed',
          refundError: error.slice(0, MAX_AUDIT_ERROR_LENGTH),
        },
      });
    });
  }

  /**
   * Registra el evento en `audit_log` con el cliente de la transacción que
   * hace la transición: si ésta no cambió nada, no se llama.
   */
  private async audit(
    db: AuditDb,
    event: {
      action: string;
      reservation: Reservation;
      actor: ReservationActor;
      severity?: 'info' | 'warn';
      extra?: Record<string, string | number | undefined>;
    },
  ): Promise<void> {
    const { reservation, actor } = event;
    await db.auditLog.create({
      data: {
        action: event.action,
        entityType: 'reservation',
        entityId: reservation.id,
        actorUserId: actor.userId,
        tenantId: reservation.tenantId,
        severity: event.severity ?? 'info',
        metadata: {
          actorRole: actor.role,
          previousStatus: reservation.status,
          vehiclePlate: reservation.vehiclePlate,
          entryAt: reservation.entryAt.toISOString(),
          ...event.extra,
        },
      },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReason(reason: string | undefined, instance: string): void {
  if (!reason || reason.trim().length === 0) {
    throw failure(
      HttpStatus.BAD_REQUEST,
      'A reason is required.',
      instance,
      ErrorCodes.RESERVATION_REASON_REQUIRED,
    );
  }
}

const notPendingApproval = (instance: string) =>
  failure(
    HttpStatus.CONFLICT,
    'The reservation is not waiting for approval.',
    instance,
    ErrorCodes.RESERVATION_NOT_PENDING_APPROVAL,
  );

const notCancellable = (instance: string) =>
  failure(
    HttpStatus.CONFLICT,
    'The reservation cannot be cancelled.',
    instance,
    ErrorCodes.RESERVATION_NOT_CANCELLABLE,
  );

function failure(
  status: HttpStatus,
  detail: string,
  instance: string,
  code: ErrorCode,
) {
  const title =
    status === HttpStatus.NOT_FOUND
      ? 'Not Found'
      : status === HttpStatus.BAD_REQUEST
        ? 'Bad Request'
        : 'Conflict';
  return new FormattedException(title, status, detail, instance, code);
}
