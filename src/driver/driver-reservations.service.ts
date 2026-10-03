import { isVehicleCategory } from '../vehicle-categories/vehicle-categories';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  ReservationPaymentStatus,
  ReservationStatus,
  type User,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from '../reservations/payment-gateway/reservation-payment-gateway';
import { isAllowedReturnUrl } from '../reservations/return-url';
import { resolveReservationPaymentProvider } from '../reservations/payment-gateway/reservation-payment.provider';
import { lockAndCheckCapacity } from '../reservations/reservation-capacity';
import { ReservationLifecycleService } from '../reservations/reservation-lifecycle.service';
import {
  HOLD_MINUTES,
  readPolicySnapshot,
  type PolicySnapshot,
} from '../reservations/reservation-policy';
import { isProduction } from '../utils/env';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { reservationState } from './driver-rules';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverService } from './driver.service';
import {
  CancelPreviewDto,
  CreateReservationDto,
  CreateReservationResponseDto,
  DriverReservationDetailDto,
  DriverReservationStateDto,
} from './dto/reservation.dto';
import { reservationCode } from '../reservations/reservation-checkin';

const RESERVATIONS_PATH = '/driver/reservations';
const LIST_LIMIT = 100;

const WITH_PARKING = {
  tenant: {
    select: { name: true, address: true, latitude: true, longitude: true },
  },
  // El último intento de cobro: alcanza para mostrar el estado del pago.
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
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
 *
 * Alta con `returnUrl`: la reserva nace `pending_payment` con una retención de
 * `HOLD_MINUTES` y el checkout se pide FUERA de la transacción (no se sostiene
 * el lock de la playa mientras se espera al proveedor).
 */
@Injectable()
export class DriverReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly driverService: DriverService,
    private readonly driverVehicles: DriverVehiclesService,
    private readonly lifecycle: ReservationLifecycleService,
    @Inject(RESERVATION_PAYMENT_GATEWAY)
    private readonly gateway: ReservationPaymentGateway,
  ) {}

  /**
   * Con `returnUrl` devuelve `{ reservation, payment }`. Sin él, fuera de
   * producción, el camino viejo devuelve la reserva PLANA (la forma que espera
   * mobile hoy).
   */
  async create(
    user: User,
    dto: CreateReservationDto,
    now = new Date(),
  ): Promise<CreateReservationResponseDto | DriverReservationDetailDto> {
    if (dto.returnUrl && !isAllowedReturnUrl(dto.returnUrl)) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'The returnUrl is not an allowed destination.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_RETURN_URL_NOT_ALLOWED,
      );
    }
    // TODO(fase-4): sacar el camino viejo cuando mobile mande `returnUrl`.
    const legacy = !dto.returnUrl;
    if (legacy && isProduction()) {
      throw new FormattedException(
        'Unprocessable Entity',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'This app version cannot pay for reservations; update the app.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_CLIENT_OUTDATED,
      );
    }

    // Idempotencia: el mismo id devuelve la misma reserva.
    const existing = await this.findWithParking(dto.id);
    if (existing) return this.replay(existing, user, dto, now);

    // La patente tiene que ser de un vehículo del conductor (SCRUM-285): es
    // la que la playa va a usar para reconocer la reserva en el ingreso.
    const vehicleCategory = await this.driverVehicles.findOwnedCategory(
      user,
      dto.vehiclePlate,
    );
    if (!vehicleCategory) {
      throw new FormattedException(
        'Unprocessable Entity',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The plate is not one of your vehicles.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_VEHICLE_NOT_FOUND,
      );
    }

    // Recotiza en el servidor: valida ventana, horario, tipo de vehículo,
    // reservas habilitadas y tarifa de reservas. Nunca se confía en el total
    // que calculó el cliente.
    const { quote, reservableSpots, policy } =
      await this.driverService.quoteForReservation(
        dto.parkingId,
        { entryAt: dto.entryAt, exitAt: dto.exitAt },
        now,
        vehicleCategory,
      );
    const entryAt = new Date(quote.entryAt);
    const exitAt = new Date(quote.exitAt);
    const holdExpiresAt = legacy
      ? null
      : new Date(now.getTime() + HOLD_MINUTES * 60_000);

    let created: ReservationWithParking;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Un lock por playa serializa las reservas concurrentes: sin esto, dos
        // pedidos simultáneos pueden llevarse la última plaza reservable.
        const room = await lockAndCheckCapacity(
          tx,
          dto.parkingId,
          { entryAt, exitAt },
          reservableSpots,
          now,
        );
        if (!room) {
          throw failure(
            HttpStatus.CONFLICT,
            'No reservable spots left for the requested window.',
            RESERVATIONS_PATH,
            ErrorCodes.RESERVATION_NO_CAPACITY,
          );
        }

        const row = await tx.reservation.create({
          data: {
            id: dto.id,
            tenantId: dto.parkingId,
            userId: user.id,
            vehiclePlate: dto.vehiclePlate,
            // Snapshot: el historial no depende de que el conductor edite su
            // vehículo después.
            vehicleCategory,
            entryAt,
            exitAt,
            totalArs: quote.totalArs,
            status: legacy
              ? ReservationStatus.confirmed
              : ReservationStatus.pending_payment,
            holdExpiresAt,
            policySnapshot: policy,
            rateSnapshotName: quote.rate.name,
            rateSnapshotHourPriceArs: quote.rate.hourPriceArs,
            // Foto completa de la tarifa: el excedente se cobra con ella.
            rateSnapshotFractionPriceArs: quote.rate.fractionPriceArs,
            rateSnapshotMediaEstadiaPriceArs: quote.rate.mediaEstadiaPriceArs,
            rateSnapshotStayPriceArs: quote.rate.stayPriceArs,
          },
          include: WITH_PARKING,
        });
        return row;
      });
    } catch (error) {
      // Carrera de reintentos: dos POST con el mismo id a la vez.
      if (isUniqueViolation(error)) {
        const raced = await this.findWithParking(dto.id);
        if (raced) return this.replay(raced, user, dto, now);
      }
      throw error;
    }

    if (legacy) return this.toDto(created, now);

    const checkout = await this.obtainCheckout(
      created,
      dto.returnUrl as string,
      now,
      true,
    );
    return this.checkoutResponse(
      { ...created, payments: [checkout] },
      checkout.checkoutUrl,
      now,
    );
  }

  async list(
    user: User,
    now = new Date(),
  ): Promise<DriverReservationDetailDto[]> {
    const rows = await this.prisma.reservation.findMany({
      where: { userId: user.id },
      include: WITH_PARKING,
      orderBy: { entryAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map((row) => this.toDto(row, now));
  }

  async get(
    user: User,
    reservationId: string,
    now = new Date(),
  ): Promise<DriverReservationDetailDto> {
    const reservation = await this.findOwned(
      user,
      reservationId,
      `${RESERVATIONS_PATH}/${reservationId}`,
    );
    return this.toDto(reservation, now);
  }

  /**
   * Cancela según la política de la playa (ver `lifecycle.driverCancel`):
   * reembolso total antes del corte, parcial después, ninguno si todavía no
   * pagó.
   */
  async cancel(
    user: User,
    reservationId: string,
    now = new Date(),
  ): Promise<DriverReservationDetailDto> {
    await this.lifecycle.driverCancel(user.id, reservationId, now);
    const updated = await this.findOwned(
      user,
      reservationId,
      `${RESERVATIONS_PATH}/${reservationId}/cancel`,
    );
    return this.toDto(updated, now);
  }

  async cancelPreview(
    user: User,
    reservationId: string,
    now = new Date(),
  ): Promise<CancelPreviewDto> {
    const reservation = await this.findOwned(
      user,
      reservationId,
      `${RESERVATIONS_PATH}/${reservationId}/cancel-preview`,
    );
    return this.lifecycle.previewCancel(reservation, 'driver', now);
  }

  /**
   * Vuelve a pedir el pago de una reserva `pending_payment`: el mismo
   * `checkoutUrl` si el pago sigue vivo, uno nuevo si el último intento se
   * rechazó. Con la retención vencida, 409 `RESERVATION_HOLD_EXPIRED`.
   */
  async paymentRetry(
    user: User,
    reservationId: string,
    now = new Date(),
  ): Promise<CreateReservationResponseDto> {
    const instance = `${RESERVATIONS_PATH}/${reservationId}/payment`;
    const reservation = await this.findOwned(user, reservationId, instance);
    assertPayable(reservation, instance, now);
    const payment = await this.obtainCheckout(reservation, null, now, false);
    return this.checkoutResponse(
      { ...reservation, payments: [payment] },
      payment.checkoutUrl,
      now,
    );
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private findWithParking(id: string) {
    return this.prisma.reservation.findUnique({
      where: { id },
      include: WITH_PARKING,
    });
  }

  /** Reserva propia; la de otro conductor responde 404, como si no existiera. */
  private async findOwned(
    user: User,
    reservationId: string,
    instance: string,
  ): Promise<ReservationWithParking> {
    const reservation = await this.findWithParking(reservationId);
    if (!reservation || reservation.userId !== user.id) {
      throw failure(
        HttpStatus.NOT_FOUND,
        'Reservation not found.',
        instance,
        ErrorCodes.RESERVATION_NOT_FOUND,
      );
    }
    return reservation;
  }

  /**
   * Devuelve el pago vivo (`created`) de la reserva o crea uno nuevo. El
   * checkout se pide al proveedor SIN transacción abierta. Si falla en el alta
   * (`expireOnFailure`) la reserva pasa a `expired` con `checkout_unavailable`
   * y responde 503; en un reintento sólo responde 503 y la reserva sigue viva.
   */
  private async obtainCheckout(
    reservation: ReservationWithParking,
    returnUrl: string | null,
    now: Date,
    expireOnFailure: boolean,
  ) {
    const latest = reservation.payments[0];
    if (latest?.status === ReservationPaymentStatus.approved) {
      throw failure(
        HttpStatus.CONFLICT,
        'The reservation is already paid.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_ALREADY_PAID,
      );
    }
    if (
      latest?.status === ReservationPaymentStatus.created &&
      latest.checkoutUrl
    ) {
      return latest;
    }

    const amountArs = Number(reservation.totalArs);
    const holdExpiresAt = reservation.holdExpiresAt ?? now;
    const effectiveReturnUrl = returnUrl ?? latest?.returnUrl ?? null;
    let checkout: Awaited<
      ReturnType<ReservationPaymentGateway['createCheckout']>
    >;
    try {
      checkout = await this.gateway.createCheckout({
        reservation: { id: reservation.id },
        tenantId: reservation.tenantId,
        amountArs,
        expiresAt: holdExpiresAt,
        returnUrl: effectiveReturnUrl ?? '',
        description: {
          parkingName: reservation.tenant.name,
          entryAt: reservation.entryAt,
          exitAt: reservation.exitAt,
        },
      });
    } catch {
      if (expireOnFailure) {
        await this.prisma.reservation.updateMany({
          where: {
            id: reservation.id,
            tenantId: reservation.tenantId,
            status: ReservationStatus.pending_payment,
          },
          data: {
            status: ReservationStatus.expired,
            reason: 'checkout_unavailable',
          },
        });
      }
      throw failure(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The payment provider could not create the checkout.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_CHECKOUT_UNAVAILABLE,
      );
    }

    try {
      return await this.prisma.reservationPayment.create({
        data: {
          reservationId: reservation.id,
          tenantId: reservation.tenantId,
          amountArs,
          status: ReservationPaymentStatus.created,
          provider: resolveReservationPaymentProvider(),
          providerPreferenceId: checkout.preferenceId,
          checkoutUrl: checkout.checkoutUrl,
          returnUrl: effectiveReturnUrl,
        },
      });
    } catch (error) {
      // Dos pedidos a la vez crearon el checkout: gana el que ya se guardó.
      if (isUniqueViolation(error)) {
        const live = await this.prisma.reservationPayment.findFirst({
          where: {
            reservationId: reservation.id,
            tenantId: reservation.tenantId,
            status: ReservationPaymentStatus.created,
          },
        });
        if (live) return live;
      }
      throw error;
    }
  }

  private checkoutResponse(
    reservation: ReservationWithParking,
    checkoutUrl: string | null,
    now: Date,
  ): CreateReservationResponseDto {
    return {
      reservation: this.toDto(reservation, now),
      payment: {
        checkoutUrl,
        holdExpiresAt: reservation.holdExpiresAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * Reintento con un id ya usado: sólo vale si es la misma reserva. Con
   * `returnUrl` devuelve el mismo `checkoutUrl` mientras la retención siga
   * viva (y lo recrea si el alta anterior se cortó antes de guardarlo).
   */
  private async replay(
    existing: ReservationWithParking,
    user: User,
    dto: CreateReservationDto,
    now: Date,
  ): Promise<CreateReservationResponseDto | DriverReservationDetailDto> {
    if (existing.userId !== user.id || existing.tenantId !== dto.parkingId) {
      throw failure(
        HttpStatus.CONFLICT,
        'Reservation id already used.',
        RESERVATIONS_PATH,
        ErrorCodes.RESERVATION_ID_CONFLICT,
      );
    }
    if (!dto.returnUrl) return this.toDto(existing, now);

    const waiting =
      existing.status === ReservationStatus.pending_payment &&
      isHoldAlive(existing, now);
    if (!waiting) return this.checkoutResponse(existing, null, now);

    const payment = await this.obtainCheckout(
      existing,
      dto.returnUrl,
      now,
      false,
    );
    return this.checkoutResponse(
      { ...existing, payments: [payment] },
      payment.checkoutUrl,
      now,
    );
  }

  private toDto(
    row: ReservationWithParking,
    now: Date,
  ): DriverReservationDetailDto {
    const payment = row.payments[0] ?? null;
    return {
      id: row.id,
      code: reservationCode(row.id),
      state: reservationState(
        row.status,
        row.exitAt,
        now,
      ) as DriverReservationStateDto,
      cancellable: this.lifecycle.previewCancel(row, 'driver', now).allowed,
      parkingId: row.tenantId,
      parkingName: row.tenant.name,
      parkingAddress: row.tenant.address,
      latitude:
        row.tenant.latitude === null ? null : Number(row.tenant.latitude),
      longitude:
        row.tenant.longitude === null ? null : Number(row.tenant.longitude),
      vehiclePlate: row.vehiclePlate,
      vehicleCategory: isVehicleCategory(row.vehicleCategory)
        ? row.vehicleCategory
        : null,
      entryAt: row.entryAt.toISOString(),
      exitAt: row.exitAt.toISOString(),
      totalArs: Number(row.totalArs),
      rateName: row.rateSnapshotName,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
      refundStatus: row.refundStatus,
      refundedAmountArs:
        row.refundedAmountArs === null ? null : Number(row.refundedAmountArs),
      policy: readPolicySnapshot(row.policySnapshot) satisfies PolicySnapshot,
      holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
      approvalDeadlineAt: row.approvalDeadlineAt?.toISOString() ?? null,
      payment: payment
        ? {
            status: payment.status,
            // La URL sólo sirve mientras el pago está pendiente.
            checkoutUrl:
              payment.status === ReservationPaymentStatus.created
                ? payment.checkoutUrl
                : null,
          }
        : null,
      cancelledBy: row.cancelledBy,
      reason: row.reason,
    };
  }
}

function isHoldAlive(
  reservation: { holdExpiresAt: Date | null },
  now: Date,
): boolean {
  return (
    reservation.holdExpiresAt !== null &&
    reservation.holdExpiresAt.getTime() > now.getTime()
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Sólo una `pending_payment` con la retención viva se puede (re)pagar. */
function assertPayable(
  reservation: { status: ReservationStatus; holdExpiresAt: Date | null },
  instance: string,
  now: Date,
): void {
  const { status } = reservation;
  if (status === ReservationStatus.pending_payment) {
    if (isHoldAlive(reservation, now)) return;
    throw failure(
      HttpStatus.CONFLICT,
      'The payment hold expired.',
      instance,
      ErrorCodes.RESERVATION_HOLD_EXPIRED,
    );
  }
  if (status === ReservationStatus.expired) {
    throw failure(
      HttpStatus.CONFLICT,
      'The payment hold expired.',
      instance,
      ErrorCodes.RESERVATION_HOLD_EXPIRED,
    );
  }
  const paid: ReservationStatus[] = [
    ReservationStatus.pending_approval,
    ReservationStatus.confirmed,
    ReservationStatus.checked_in,
    ReservationStatus.completed,
  ];
  throw failure(
    HttpStatus.CONFLICT,
    paid.includes(status)
      ? 'The reservation is already paid.'
      : 'The reservation can no longer be paid.',
    instance,
    paid.includes(status)
      ? ErrorCodes.RESERVATION_ALREADY_PAID
      : ErrorCodes.RESERVATION_NOT_PAYABLE,
  );
}

function failure(
  status: HttpStatus,
  detail: string,
  instance: string,
  code: ErrorCode,
) {
  const title =
    status === HttpStatus.NOT_FOUND
      ? 'Not Found'
      : status === HttpStatus.SERVICE_UNAVAILABLE
        ? 'Service Unavailable'
        : 'Conflict';
  return new FormattedException(title, status, detail, instance, code);
}
