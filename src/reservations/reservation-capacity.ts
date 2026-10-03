/**
 * Cupo de reservas por playa: el `where` de Prisma de lo que retiene lugar y el
 * chequeo con lock que comparten el alta y el pago tardío.
 */
import { Prisma, ReservationStatus } from '@prisma/client';
import {
  hasReservationQuotaFor,
  peakConcurrentReservations,
  type ReservationWindow,
} from '../driver/driver-rules';
import { HOLD_GRACE_MS } from './reservation-policy';

/**
 * `where` de las reservas que cuentan contra el cupo en `now`: las de
 * `pending_approval`, `confirmed` y `checked_in`, más las `pending_payment` con
 * la retención (y su margen) todavía viva. Es la misma regla que
 * `countsAgainstQuota`.
 *
 * Usa la clave `OR` de primer nivel: si el caller necesita su propio `OR`,
 * tiene que combinarlos con `AND`.
 */
export function holdingWhere(now: Date): Prisma.ReservationWhereInput {
  return {
    OR: [
      {
        status: {
          in: [
            ReservationStatus.pending_approval,
            ReservationStatus.confirmed,
            ReservationStatus.checked_in,
          ],
        },
      },
      {
        status: ReservationStatus.pending_payment,
        holdExpiresAt: { gt: new Date(now.getTime() - HOLD_GRACE_MS) },
      },
    ],
  };
}

/**
 * Toma el lock de la playa y dice si la ventana todavía entra en el cupo.
 *
 * `pg_advisory_xact_lock(hashtext(tenantId))` serializa las altas (y los pagos
 * tardíos) concurrentes de una playa: sin él, dos pedidos simultáneos pueden
 * llevarse la última plaza. El lock vive hasta el fin de la transacción `tx`,
 * así que el caller tiene que escribir su reserva DENTRO de la misma
 * transacción. `excludeId` saca del conteo a la reserva que está por
 * confirmarse (el pago tardío no debe competir contra sí misma).
 */
export async function lockAndCheckCapacity(
  tx: Prisma.TransactionClient,
  tenantId: string,
  window: ReservationWindow,
  reservableSpots: number,
  now: Date,
  excludeId?: string,
): Promise<boolean> {
  // `$executeRaw` y no `$queryRaw`: la función devuelve `void`, que Prisma no
  // deserializa.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

  const overlapping = await tx.reservation.findMany({
    where: {
      tenantId,
      ...holdingWhere(now),
      ...(excludeId ? { id: { not: excludeId } } : {}),
      entryAt: { lt: window.exitAt },
      exitAt: { gt: window.entryAt },
    },
    select: { entryAt: true, exitAt: true },
  });
  const peak = peakConcurrentReservations(overlapping, window);
  return hasReservationQuotaFor(reservableSpots, peak);
}
