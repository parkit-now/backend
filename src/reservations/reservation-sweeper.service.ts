import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { HOLD_GRACE_MS, readPolicySnapshot } from './reservation-policy';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

/** Tope por regla y por corrida: una corrida no barre sin límite. */
const BATCH_SIZE = 100;

export type SweepResult = {
  expired: number;
  rejected: number;
  noShow: number;
};

/**
 * Barrido de reservas: cada minuto vence lo que corresponde, por lotes y de
 * forma idempotente (cada transición es un `updateMany` guardado por estado).
 *
 * 1. `pending_payment` con la retención + 5 min vencida pasa a `expired`.
 * 2. `pending_approval` con `approvalDeadlineAt` vencido pasa a `rejected`
 *    (`system`, `approval_timeout`) con reembolso total.
 * 3. `confirmed` con `entryAt + graceMinutes` (del snapshot de la reserva)
 *    vencido pasa a `no_show`.
 *
 * Los reembolsos `failed` NO se reintentan solos: los reintenta el dueño.
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
        await this.attempt(id, () =>
          this.lifecycle.expireHold(id, tenantId, now),
        )
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
