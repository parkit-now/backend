import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from './payment-gateway/reservation-payment-gateway';
import { HOLD_GRACE_MS, readPolicySnapshot } from './reservation-policy';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

/** Tope por regla y por corrida: una corrida no barre sin límite. */
const BATCH_SIZE = 100;

/**
 * Un reembolso pendiente se reconcilia recién pasado este tiempo: antes, el
 * webhook (o el propio pedido de reembolso) todavía tiene tiempo de confirmarlo.
 */
const REFUND_RECONCILE_AFTER_MS = 10 * 60_000;

/** Los errores del token que no se arreglan reintentando: lo arregla el dueño. */
const TOKEN_UNUSABLE_CODES: readonly string[] = [
  ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED,
  ErrorCodes.MP_ACCOUNT_REVOKED,
  ErrorCodes.MP_NOT_LINKED,
];

const TOKEN_UNUSABLE_MESSAGE =
  'La cuenta de Mercado Pago del estacionamiento está vencida o desvinculada. Volvé a vincularla y reintentá el reembolso.';

export type SweepResult = {
  expired: number;
  rejected: number;
  noShow: number;
};

/**
 * Barrido de reservas: cada minuto vence lo que corresponde, por lotes y de
 * forma idempotente (cada transición es un `updateMany` guardado por estado).
 *
 * 1. `pending_payment` con la retención + 5 min vencida pasa a `expired`,
 *    salvo que Mercado Pago diga que ya se pagó (webhook perdido): entonces se
 *    confirma con `markPaid`. Si la consulta falla se vence igual (el pago
 *    tardío lo cubre el webhook + reembolso).
 * 2. `pending_approval` con `approvalDeadlineAt` vencido pasa a `rejected`
 *    (`system`, `approval_timeout`) con reembolso total.
 * 3. `confirmed` con `entryAt + graceMinutes` (del snapshot de la reserva)
 *    vencido pasa a `no_show`.
 *
 * Los reembolsos `failed` NO se reintentan solos: los reintenta el dueño.
 * Los `pending` los reconcilia `reconcileRefunds` (cada 15 min).
 *
 * ## Sin lock, y es deliberado
 *
 * Mismo criterio que `MpTokenService`: `pg_try_advisory_lock` es por sesión y
 * no sirve con el pool de Prisma. No hace falta: si dos instancias corren a la
 * vez, el `updateMany` guardado por estado hace que sólo una cambie la fila, y
 * la otra la cuenta como "no cambió". En Cloud Run con scale-to-zero el cron
 * corre sólo si hay una instancia viva; si no corrió, el próximo minuto
 * recupera lo atrasado.
 *
 * Limitación conocida de la regla 3: la tolerancia es por reserva (jsonb) y
 * se filtra en memoria sobre las `confirmed` con ingreso pasado, las más
 * viejas primero. Sólo se trabaría con más de 100 reservas que todavía están
 * dentro de su tolerancia y son más viejas que las vencidas.
 */
@Injectable()
export class ReservationSweeperService {
  private readonly logger = new Logger(ReservationSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ReservationLifecycleService,
    @Inject(RESERVATION_PAYMENT_GATEWAY)
    private readonly gateway: ReservationPaymentGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'reservations-sweeper' })
  async sweep(now = new Date()): Promise<SweepResult> {
    const result: SweepResult = { expired: 0, rejected: 0, noShow: 0 };

    const holds = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.pending_payment,
        holdExpiresAt: { lt: new Date(now.getTime() - HOLD_GRACE_MS) },
      },
      select: { id: true, tenantId: true },
      orderBy: { holdExpiresAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const { id, tenantId } of holds) {
      if (
        await this.attempt(id, async () => {
          // Red de seguridad del webhook: antes de vencer la retención se
          // pregunta a Mercado Pago si la reserva ya se pagó.
          if (await this.confirmIfPaid(id, tenantId)) return false;
          return this.lifecycle.expireHold(id, tenantId, now);
        })
      ) {
        result.expired++;
      }
    }

    const approvals = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.pending_approval,
        approvalDeadlineAt: { lt: now },
      },
      select: { id: true, tenantId: true },
      orderBy: { approvalDeadlineAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const { id, tenantId } of approvals) {
      if (
        await this.attempt(id, () =>
          this.lifecycle.rejectByTimeout(id, tenantId, now),
        )
      ) {
        result.rejected++;
      }
    }

    const arrivals = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.confirmed,
        entryAt: { lt: now },
      },
      select: { id: true, tenantId: true, entryAt: true, policySnapshot: true },
      orderBy: { entryAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const { id, tenantId, entryAt, policySnapshot } of arrivals) {
      const graceMs = readPolicySnapshot(policySnapshot).graceMinutes * 60_000;
      if (entryAt.getTime() + graceMs >= now.getTime()) continue;
      if (
        await this.attempt(id, () =>
          this.lifecycle.markNoShow(id, tenantId, now),
        )
      ) {
        result.noShow++;
      }
    }

    if (result.expired + result.rejected + result.noShow > 0) {
      this.logger.log(
        `Reservations sweep: ${result.expired} expired, ${result.rejected} rejected by timeout, ${result.noShow} no-show.`,
      );
    }
    return result;
  }

  /**
   * Reembolsos que quedaron `pending` (el webhook no llegó): se lee el pago en
   * el proveedor y, si ya está devuelto, se confirma. Si el token de la cuenta
   * no sirve, el reembolso pasa a `failed` con un mensaje accionable para el
   * dueño; cualquier otro error deja la reserva `pending` para la próxima.
   */
  @Cron('*/15 * * * *', { name: 'reservations-refund-reconcile' })
  async reconcileRefunds(
    now = new Date(),
  ): Promise<{ confirmed: number; failed: number }> {
    const result = { confirmed: 0, failed: 0 };
    const pending = await this.prisma.reservation.findMany({
      where: {
        refundStatus: 'pending',
        refundRequestedAt: {
          lt: new Date(now.getTime() - REFUND_RECONCILE_AFTER_MS),
        },
      },
      select: { id: true, tenantId: true },
      orderBy: { refundRequestedAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const { id, tenantId } of pending) {
      await this.attempt(id, async () => {
        const row = await this.prisma.reservationPayment.findFirst({
          where: {
            reservationId: id,
            tenantId,
            providerPaymentId: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          select: { providerPaymentId: true },
        });
        if (!row?.providerPaymentId) return false;

        try {
          const payment = await this.gateway.getPayment({
            tenantId,
            providerPaymentId: row.providerPaymentId,
          });
          if (
            payment.status !== 'refunded' &&
            payment.status !== 'partially_refunded'
          ) {
            return false;
          }
          const outcome = await this.lifecycle.confirmRefund(
            id,
            {
              refundedAmountArs: payment.refundedAmountArs || payment.amountArs,
              providerPaymentId: row.providerPaymentId,
            },
            now,
          );
          if (outcome.changed) result.confirmed++;
          return outcome.changed;
        } catch (error) {
          const code = errorCode(error);
          if (code && TOKEN_UNUSABLE_CODES.includes(code)) {
            const failed = await this.lifecycle.markRefundFailedBySystem(
              id,
              tenantId,
              TOKEN_UNUSABLE_MESSAGE,
            );
            if (failed.changed) result.failed++;
            return failed.changed;
          }
          throw error;
        }
      });
    }

    if (result.confirmed + result.failed > 0) {
      this.logger.log(
        `Refund reconcile: ${result.confirmed} confirmed, ${result.failed} failed (unusable account).`,
      );
    }
    return result;
  }

  /**
   * `true` si Mercado Pago tiene un pago aprobado de la reserva y se la
   * confirmó. Si la consulta a Mercado Pago falla se asume "no se sabe" y
   * devuelve `false` (se vence); si falla `markPaid`, tira.
   */
  private async confirmIfPaid(
    reservationId: string,
    tenantId: string,
  ): Promise<boolean> {
    let paid: Awaited<
      ReturnType<ReservationPaymentGateway['findApprovedPayment']>
    >;
    try {
      paid = await this.gateway.findApprovedPayment({
        tenantId,
        reservationId,
      });
    } catch (error) {
      this.logger.warn(
        `Could not check the payment of reservation ${reservationId} before expiring it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (!paid) return false;

    // Si `markPaid` falla, el error sube a `attempt` y la reserva NO se vence:
    // se reintenta el próximo minuto.
    await this.lifecycle.markPaid(reservationId, {
      providerPaymentId: paid.providerPaymentId,
      providerStatus: 'approved',
    });
    this.logger.log(
      `Reservation ${reservationId} was paid (payment ${paid.providerPaymentId}) but the webhook never arrived: confirmed by the sweep.`,
    );
    return true;
  }

  /** Una reserva que falla no corta el lote: se loguea y sigue la próxima. */
  private async attempt(
    id: string,
    transition: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await transition();
    } catch (error) {
      this.logger.warn(
        `Reservations sweep failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof FormattedException)) return null;
  const body: unknown = error.getResponse();
  return body !== null && typeof body === 'object' && 'code' in body
    ? String((body as Record<string, unknown>).code)
    : null;
}
