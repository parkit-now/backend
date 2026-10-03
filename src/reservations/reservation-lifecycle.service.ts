import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ReservationPaymentStatus,
  ReservationStatus,
  ServiceCode,
  type Prisma,
  type Reservation,
} from '@prisma/client';
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
      return updated.count === 0 ? null : room;
    });
    if (hadRoom === null) {
      return { changed: false, outcome: 'ignored', reservation };
    }

    await this.approvePayment(reservation, payment, now);
    if (!hadRoom) {
      await this.startRefund(reservation, Number(reservation.totalArs), now);
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
    const claimed = await this.prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        tenantId: reservation.tenantId,
        status: reservation.status,
        paidAt: null,
      },
      data: { paidAt: now },
    });
    if (claimed.count === 0) {
      return { changed: false, outcome: 'ignored', reservation };
    }
    await this.approvePayment(reservation, payment, now);
    await this.startRefund(reservation, Number(reservation.totalArs), now);
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

  // ─── Acciones del dueño ─────────────────────────────────────────────────────

  /**
   * Acepta una reserva `pending_approval`. Si el dueño ya se pasó de
   * `approvalDeadlineAt`, se aplica el vencimiento (rechazo del sistema con
   * reembolso total) y responde 409 `RESERVATION_APPROVAL_EXPIRED`.
   */
  async accept(
    tenantId: string,
    reservationId: string,
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
    const updated = await this.prisma.reservation.updateMany({
      where: {
        id: reservation.id,
        tenantId,
        status: ReservationStatus.pending_approval,
      },
      data: { status: ReservationStatus.confirmed },
    });
    if (updated.count === 0) throw notPendingApproval(instance);
    return { changed: true, reservation: await this.reload(reservation.id) };
  }

  /** Rechaza una `pending_approval`: reembolso total. */
  async reject(
    tenantId: string,
    reservationId: string,
    reason: string,
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
      by: 'owner',
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
      by: 'owner',
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
    const claimed = await this.prisma.reservation.updateMany({
      where: { id: reservation.id, tenantId, refundStatus: 'failed' },
      data: { refundStatus: 'pending' },
    });
    if (claimed.count === 0) throw notRetryable();

    await this.startRefund(
      reservation,
      Number(reservation.refundRequestedArs ?? reservation.totalArs),
      now,
    );
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
      by: 'driver',
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
      by: 'system',
      reason: 'approval_timeout',
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

  /** Marca aprobado el pago vivo de la reserva (también uno vencido por el sweeper). */
  private async approvePayment(
    reservation: Reservation,
    payment: ProviderPaymentRef,
    now: Date,
  ): Promise<void> {
    await this.prisma.reservationPayment.updateMany({
      where: {
        reservationId: reservation.id,
        tenantId: reservation.tenantId,
        status: {
          in: [
            ReservationPaymentStatus.created,
            ReservationPaymentStatus.cancelled,
          ],
        },
      },
      data: {
        status: ReservationPaymentStatus.approved,
        providerPaymentId: payment.providerPaymentId,
        providerStatus: payment.providerStatus ?? 'approved',
        providerStatusDetail: payment.providerStatusDetail,
        approvedAt: now,
      },
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
      by: 'driver' | 'owner' | 'system';
      reason: string | null;
      refundArs: number;
      now: Date;
    },
  ): Promise<Reservation | null> {
    const { tenantId } = reservation;
    const updated = await this.prisma.reservation.updateMany({
      where: { id: reservation.id, tenantId, status: reservation.status },
      data: {
        status: options.to,
        cancelledAt: options.now,
        cancelledBy: options.by,
        reason: options.reason,
      },
    });
    if (updated.count === 0) return null;

    if (reservation.status === ReservationStatus.pending_payment) {
      await this.cancelUnpaidCheckout(reservation.id, tenantId);
    } else {
      await this.startRefund(reservation, options.refundArs, options.now);
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
   * rastro. Con 0 $ no llama a nadie y el `refundStatus` queda `none`.
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
  ): Promise<void> {
    if (amountArs <= 0) return;
    const { id, tenantId } = reservation;

    const payment = await this.prisma.reservationPayment.findFirst({
      where: { reservationId: id, tenantId, providerPaymentId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
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
      await this.markRefundFailed(id, 'No approved payment to refund.');
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
      await this.markRefundFailed(id, describe(error));
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

  private async markRefundFailed(id: string, error: string): Promise<void> {
    await this.prisma.reservation.update({
      where: { id },
      data: {
        refundStatus: 'failed',
        refundError: error.slice(0, MAX_REFUND_ERROR_LENGTH),
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
