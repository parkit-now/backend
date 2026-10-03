import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ReservationStatus, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  hasReservationQuotaFor,
  peakConcurrentReservations,
  reservationState,
} from './driver-rules';
import { DriverService } from './driver.service';
import {
  CreateReservationDto,
  DriverReservationDto,
  DriverReservationStateDto,
} from './dto/reservation.dto';

const RESERVATIONS_PATH = '/driver/reservations';
const LIST_LIMIT = 100;

const WITH_PARKING = {
  tenant: {
    select: { name: true, address: true, latitude: true, longitude: true },
  },
} satisfies Prisma.ReservationInclude;

type ReservationWithParking = Prisma.ReservationGetPayload<{
  include: typeof WITH_PARKING;
}>;

/**
 * Reservas del conductor (SCRUM-284). El cupo es `reservable_spots` de
 * "Servicios → Reservas" (SCRUM-214) y se cobra con la tarifa de reservas.
 *
 * El conductor no es miembro de ninguna playa: sus reservas se leen por
 * `user_id` entre todas. La escritura de una reserva sí queda acotada a UNA
 * playa y se hace dentro de una transacción con `tenant_id` explícito, porque
 * el cliente transaccional no admite la extensión `prismaForTenant`.
 */
@Injectable()
export class DriverReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly driverService: DriverService,
  ) {}

  async create(
    user: User,
    dto: CreateReservationDto,
    now = new Date(),
  ): Promise<DriverReservationDto> {
    // Idempotencia: el mismo id devuelve la misma reserva.
    const existing = await this.findWithParking(dto.id);
    if (existing) return this.replay(existing, user, dto, now);

    // Recotiza en el servidor: valida ventana, horario, reservas habilitadas
    // y tarifa de reservas. Nunca se confía en el total que calculó el cliente.
    const { quote, reservableSpots } =
      await this.driverService.quoteForReservation(
        dto.parkingId,
        { entryAt: dto.entryAt, exitAt: dto.exitAt },
        now,
      );
    const entryAt = new Date(quote.entryAt);
    const exitAt = new Date(quote.exitAt);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Un lock por playa serializa las reservas concurrentes: sin esto, dos
        // pedidos simultáneos pueden llevarse la última plaza reservable.
        // `$executeRaw` y no `$queryRaw`: la función devuelve `void`, que
        // Prisma no deserializa.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.parkingId}))`;

        const overlapping = await tx.reservation.findMany({
          where: {
            tenantId: dto.parkingId,
            status: ReservationStatus.confirmed,
            entryAt: { lt: exitAt },
            exitAt: { gt: entryAt },
          },
          select: { entryAt: true, exitAt: true },
        });
        const peak = peakConcurrentReservations(overlapping, {
          entryAt,
          exitAt,
        });
        if (!hasReservationQuotaFor(reservableSpots, peak)) {
          throw failure(
            HttpStatus.CONFLICT,
            'No reservable spots left for the requested window.',
            RESERVATIONS_PATH,
            ErrorCodes.RESERVATION_NO_CAPACITY,
          );
        }

        return tx.reservation.create({
          data: {
            id: dto.id,
            tenantId: dto.parkingId,
            userId: user.id,
            vehiclePlate: dto.vehiclePlate,
            entryAt,
            exitAt,
            totalArs: quote.totalArs,
            rateSnapshotName: quote.rate.name,
            rateSnapshotHourPriceArs: quote.rate.hourPriceArs,
          },
          include: WITH_PARKING,
        });
      });
      return toDto(created, now);
    } catch (error) {
      // Carrera de reintentos: dos POST con el mismo id a la vez.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.findWithParking(dto.id);
        if (raced) return this.replay(raced, user, dto, now);
      }
      throw error;
    }
  }

  async list(user: User, now = new Date()): Promise<DriverReservationDto[]> {
    const rows = await this.prisma.reservation.findMany({
      where: { userId: user.id },
      include: WITH_PARKING,
      orderBy: { entryAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map((row) => toDto(row, now));
  }

  async cancel(
    user: User,
    reservationId: string,
    now = new Date(),
  ): Promise<DriverReservationDto> {
    const instance = `${RESERVATIONS_PATH}/${reservationId}/cancel`;
    const reservation = await this.findWithParking(reservationId);
    if (!reservation || reservation.userId !== user.id) {
      throw failure(
        HttpStatus.NOT_FOUND,
        'Reservation not found.',
        instance,
        ErrorCodes.RESERVATION_NOT_FOUND,
      );
    }
    if (!isCancellable(reservation, now)) {
      throw failure(
        HttpStatus.CONFLICT,
        'The reservation already started or was cancelled.',
        instance,
        ErrorCodes.RESERVATION_NOT_CANCELLABLE,
      );
    }
    const updated = await this.prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.cancelled, cancelledAt: now },
      include: WITH_PARKING,
    });
    return toDto(updated, now);
  }

  private findWithParking(id: string) {
    return this.prisma.reservation.findUnique({
      where: { id },
      include: WITH_PARKING,
    });
  }

  /** Reintento con un id ya usado: sólo vale si es la misma reserva. */
  private replay(
    existing: ReservationWithParking,
    user: User,
    dto: CreateReservationDto,
    now: Date,
  ): DriverReservationDto {
    if (existing.userId !== user.id || existing.tenantId !== dto.parkingId) {
      throw failure(
        HttpStatus.CONFLICT,
        'Reservation id already used.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_ID_CONFLICT,
      );
    }
    return toDto(existing, now);
  }
}

function isCancellable(
  reservation: { status: ReservationStatus; entryAt: Date },
  now: Date,
): boolean {
  return (
    reservation.status === ReservationStatus.confirmed &&
    now.getTime() < reservation.entryAt.getTime()
  );
}

function toDto(row: ReservationWithParking, now: Date): DriverReservationDto {
  return {
    id: row.id,
    code: `R-${row.id.replace(/-/g, '').slice(-6).toUpperCase()}`,
    state: reservationState(
      row.status,
      row.exitAt,
      now,
    ) as DriverReservationStateDto,
    cancellable: isCancellable(row, now),
    parkingId: row.tenantId,
    parkingName: row.tenant.name,
    parkingAddress: row.tenant.address,
    latitude: row.tenant.latitude === null ? null : Number(row.tenant.latitude),
    longitude:
      row.tenant.longitude === null ? null : Number(row.tenant.longitude),
    vehiclePlate: row.vehiclePlate,
    entryAt: row.entryAt.toISOString(),
    exitAt: row.exitAt.toISOString(),
    totalArs: Number(row.totalArs),
    rateName: row.rateSnapshotName,
    createdAt: row.createdAt.toISOString(),
  };
}

function failure(
  status: HttpStatus,
  detail: string,
  instance: string,
  code: ErrorCode,
) {
  const title = status === HttpStatus.NOT_FOUND ? 'Not Found' : 'Conflict';
  return new FormattedException(title, status, detail, instance, code);
}
