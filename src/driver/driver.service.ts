import { HttpStatus, Injectable } from '@nestjs/common';
import { BranchStatus, Prisma, ServiceCode, type User } from '@prisma/client';
import { DEFAULT_TIME_ZONE, dayKeyIn, dayRangeIn } from '../metrics/metrics-tz';
import { readCapacity } from '../entities/entity-settings';
import { calcStayPrice } from '../entries/pricing';
import { effectiveReservationHours } from '../services/reservation-hours';
import { computeReservationReadiness } from '../services/reservation-readiness';
import { PrismaService } from '../database/prisma.service';
import { prismaForTenant } from '../database/prisma-tenant';
import { holdingWhere } from '../reservations/reservation-capacity';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  DEFAULT_GRACE_MINUTES,
  RESERVATION_MAX_DAYS_AHEAD,
  availableSpots,
  boundingBox,
  distanceMeters,
  isOpenAt,
  isOpenThroughout,
  reservationHoldsSpotNow,
  reservationWindowProblem,
  type ScheduleRange,
  type WindowProblem,
} from './driver-rules';
import {
  DriverNearbyParkingDto,
  DriverParkingDetailDto,
  DriverParkingDto,
} from './dto/driver-parking.dto';
import {
  DEFAULT_RADIUS_METERS,
  NearbyParkingsQueryDto,
} from './dto/nearby-parkings-query.dto';
import { CreateQuoteDto, QuoteDto } from './dto/quote.dto';
import { DriverVehiclesService } from './driver-vehicles.service';

const MAX_RESULTS = 50;

const WINDOW_ERRORS: Record<WindowProblem, ErrorCode> = {
  exit_not_after_entry: ErrorCodes.RESERVATION_EXIT_NOT_AFTER_ENTRY,
  entry_in_past: ErrorCodes.RESERVATION_ENTRY_IN_PAST,
  entry_too_far: ErrorCodes.RESERVATION_ENTRY_TOO_FAR,
  stay_too_long: ErrorCodes.RESERVATION_STAY_TOO_LONG,
};

type PublicTenant = {
  id: string;
  name: string;
  address: string | null;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
  settings: Prisma.JsonValue;
};

type ReservationRate = {
  name: string;
  hourPriceArs: number;
  fractionPriceArs: number;
  mediaEstadiaPriceArs: number;
  stayPriceArs: number;
};

type LotData = {
  schedules: ScheduleRange[];
  /**
   * Tarifa de reservas configurada en "Servicios → Reservas" (SCRUM-214).
   * `null` si la playa no toma reservas: servicio apagado, sin tarifa (o
   * borrada/inactiva) o sin cupo. Una sola tarifa, sin distinción de vehículo.
   */
  reservationRate: ReservationRate | null;
  /** Plazas reservables a la vez; `null` si no toma reservas. */
  reservableSpots: number | null;
  /**
   * Reglas del servicio de reservas; `null` si la playa no toma reservas. Las
   * ve el conductor (parking DTO) y las aplica la cotización.
   */
  reservation: {
    vehicleKinds: string[];
    hoursMode: string;
    /** Horario efectivo: el propio en `custom`, el de apertura en `opening`. */
    hours: ScheduleRange[];
    acceptanceMode: string;
    freeCancelMinutes: number;
    lateCancelRefundPct: number;
    earlyArrivalMinutes: number;
    graceMinutes: number;
  } | null;
  occupied: number;
  /** Reservas de hoy que todavía ocupan lugar (ver reservationHoldsSpotNow). */
  reservedToday: number;
};

const PUBLIC_TENANT_SELECT = {
  id: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
  settings: true,
} satisfies Prisma.TenantSelect;

/**
 * API de solo lectura para la app del conductor.
 *
 * A diferencia del resto de los servicios, no opera sobre UN tenant elegido
 * por la ruta: el conductor no es miembro de ninguna playa y busca entre
 * todas. Para no saltear la capa de aislamiento de aplicación, los datos de
 * cada playa se leen con `prismaForTenant(...)` (inyecta el `WHERE tenant_id`)
 * y nunca se escribe nada. La lista de tenants usa el cliente base: `Tenant`
 * es global. Todo lo que sale va por DTOs públicos acotados.
 */
@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly driverVehicles: DriverVehiclesService,
  ) {}

  async findNearby(
    query: NearbyParkingsQueryDto,
    now = new Date(),
  ): Promise<DriverNearbyParkingDto[]> {
    const center = { latitude: query.latitude, longitude: query.longitude };
    const radius = query.radiusMeters ?? DEFAULT_RADIUS_METERS;
    const box = boundingBox(center, radius);

    const tenants = await this.prisma.tenant.findMany({
      where: {
        status: BranchStatus.active,
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
      select: PUBLIC_TENANT_SELECT,
    });

    const inRadius = tenants
      .map((tenant) => ({
        tenant,
        distance: distanceMeters(center, coordinatesOf(tenant)),
      }))
      .filter(({ distance }) => distance <= radius)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, MAX_RESULTS);

    return Promise.all(
      inRadius.map(async ({ tenant, distance }) => ({
        ...toParkingDto(tenant, await this.loadLotData(tenant, now), now),
        distanceMeters: Math.round(distance),
      })),
    );
  }

  async findOne(
    parkingId: string,
    now = new Date(),
  ): Promise<DriverParkingDetailDto> {
    const tenant = await this.findPublicTenant(parkingId);
    const lot = await this.loadLotData(tenant, now);
    return {
      ...toParkingDto(tenant, lot, now),
      schedules: sortSchedules(lot.schedules),
      reservationMaxDaysAhead: RESERVATION_MAX_DAYS_AHEAD,
    };
  }

  async quote(
    parkingId: string,
    dto: CreateQuoteDto,
    user: User,
    now = new Date(),
  ): Promise<QuoteDto> {
    // Con `vehiclePlate`, la cotización conoce el tipo de vehículo y valida
    // que la playa lo acepte, igual que la reserva.
    let vehicleKind: string | undefined;
    if (dto.vehiclePlate) {
      const kind = await this.driverVehicles.findOwnedKind(
        user,
        dto.vehiclePlate,
      );
      if (!kind) {
        throw unprocessable(
          'The plate is not one of your vehicles.',
          `/driver/parkings/${parkingId}/quote`,
          ErrorCodes.RESERVATION_VEHICLE_NOT_FOUND,
        );
      }
      vehicleKind = kind;
    }
    return (await this.quoteForReservation(parkingId, dto, now, vehicleKind))
      .quote;
  }

  /**
   * Cotización + cupo de reservas de la playa, leídos de una sola vez: la
   * creación de una reserva necesita las dos cosas (ver
   * DriverReservationsService).
   */
  async quoteForReservation(
    parkingId: string,
    dto: CreateQuoteDto,
    now = new Date(),
    vehicleKind?: string,
  ): Promise<{ quote: QuoteDto; reservableSpots: number }> {
    const tenant = await this.findPublicTenant(parkingId);
    const lot = await this.loadLotData(tenant, now);
    const entryAt = new Date(dto.entryAt);
    const exitAt = new Date(dto.exitAt);
    const instance = `/driver/parkings/${parkingId}/quote`;

    const windowProblem = reservationWindowProblem(entryAt, exitAt, now);
    if (windowProblem) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        `Invalid reservation window: ${windowProblem}.`,
        instance,
        WINDOW_ERRORS[windowProblem],
      );
    }
    const rate = lot.reservationRate;
    if (!rate) {
      throw unprocessable(
        'This parking lot does not take reservations.',
        instance,
        ErrorCodes.DRIVER_RESERVATIONS_DISABLED,
      );
    }
    // Sin horarios cargados no se puede validar: se permite (null).
    if (isOpenThroughout(lot.schedules, entryAt, exitAt) === false) {
      throw unprocessable(
        'The parking lot closes during the requested stay.',
        instance,
        ErrorCodes.RESERVATION_OUTSIDE_OPENING_HOURS,
      );
    }
    // `rate` no nulo ⇒ `lot.reservation` no nulo (ver loadLotData).
    const rules = lot.reservation;
    if (rules && vehicleKind && !rules.vehicleKinds.includes(vehicleKind)) {
      throw unprocessable(
        `This parking lot does not take reservations for '${vehicleKind}' vehicles.`,
        instance,
        ErrorCodes.RESERVATION_VEHICLE_KIND_NOT_ACCEPTED,
      );
    }
    // Horario propio: la estadía entera tiene que caer dentro de sus rangos.
    // Sin rangos (`null`) tampoco se puede reservar.
    if (
      rules?.hoursMode === 'custom' &&
      isOpenThroughout(rules.hours, entryAt, exitAt) !== true
    ) {
      throw unprocessable(
        'The stay is outside the hours in which this parking lot takes reservations.',
        instance,
        ErrorCodes.RESERVATION_OUTSIDE_RESERVATION_HOURS,
      );
    }

    const durationMinutes = Math.round(
      (exitAt.getTime() - entryAt.getTime()) / 60_000,
    );
    const quote: QuoteDto = {
      parkingId: tenant.id,
      entryAt: entryAt.toISOString(),
      exitAt: exitAt.toISOString(),
      durationMinutes,
      totalArs: calcStayPrice(durationMinutes, {
        hour: rate.hourPriceArs,
        fraction: rate.fractionPriceArs,
        mediaEstadia: rate.mediaEstadiaPriceArs,
        stay: rate.stayPriceArs,
      }),
      rate: {
        name: rate.name,
        hourPriceArs: rate.hourPriceArs,
        fractionPriceArs: rate.fractionPriceArs,
        mediaEstadiaPriceArs: rate.mediaEstadiaPriceArs,
        stayPriceArs: rate.stayPriceArs,
      },
    };
    // `rate` no nulo ⇒ la playa toma reservas ⇒ hay cupo (ver loadLotData).
    return { quote, reservableSpots: lot.reservableSpots ?? 0 };
  }

  /** Activa y con ubicación publicada; si no, para el conductor no existe. */
  private async findPublicTenant(parkingId: string): Promise<PublicTenant> {
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        id: parkingId,
        status: BranchStatus.active,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: PUBLIC_TENANT_SELECT,
    });
    if (!tenant) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Parking lot not found.',
        `/driver/parkings/${parkingId}`,
        ErrorCodes.DRIVER_PARKING_NOT_FOUND,
      );
    }
    return tenant;
  }

  private async loadLotData(tenant: PublicTenant, now: Date): Promise<LotData> {
    const tenantId = tenant.id;
    const tenantPrisma = prismaForTenant(this.prisma, tenantId);
    const today = dayRangeIn(
      dayKeyIn(now, DEFAULT_TIME_ZONE),
      DEFAULT_TIME_ZONE,
    );
    const [
      schedules,
      reservationService,
      reservationRanges,
      mpAccount,
      occupied,
      todays,
    ] = await Promise.all([
      tenantPrisma.schedule.findMany({
        select: { day: true, openMinute: true, closeMinute: true },
      }),
      tenantPrisma.service.findFirst({
        where: { code: ServiceCode.ADVANCE_RESERVATION },
        select: {
          enabled: true,
          reservableSpots: true,
          reservationVehicleKinds: true,
          reservationHoursMode: true,
          acceptanceMode: true,
          freeCancelMinutes: true,
          lateCancelRefundPct: true,
          earlyArrivalMinutes: true,
          graceMinutes: true,
          reservationRate: {
            select: {
              name: true,
              hourPriceArs: true,
              fractionPriceArs: true,
              mediaEstadiaPriceArs: true,
              stayPriceArs: true,
              isActive: true,
              deletedAt: true,
            },
          },
        },
      }),
      tenantPrisma.reservationHour.findMany({
        select: { day: true, openMinute: true, closeMinute: true },
      }),
      // `MpAccount` es global: cliente base, filtrado a mano por playa. Sólo
      // el estado; los tokens no se leen acá.
      this.prisma.mpAccount.findUnique({
        where: { tenantId },
        select: { status: true },
      }),
      tenantPrisma.entry.count({ where: { leftAt: null } }),
      // Reservas de hoy que retienen lugar (holdingWhere): las que todavía no
      // vencieron lo ocupan (SCRUM-261, ver reservationHoldsSpotNow).
      tenantPrisma.reservation.findMany({
        where: {
          ...holdingWhere(now),
          entryAt: { gte: today.gte, lt: today.lt },
        },
        select: { entryAt: true, status: true, holdExpiresAt: true },
      }),
    ]);

    const rate = reservationService?.reservationRate;
    const spots = reservationService?.reservableSpots ?? 0;
    const rateUsable = !!rate && rate.isActive && !rate.deletedAt;
    // Mismo criterio que la activación del dueño (ver ServicesService): el
    // servicio activo no alcanza si después se desvinculó Mercado Pago o se
    // rompió algún requisito.
    const readiness = computeReservationReadiness({
      mpStatus: mpAccount?.status ?? null,
      reservableSpots: spots,
      capacityTotal: readCapacity(tenant.settings).total,
      rateUsable,
      vehicleKinds: reservationService?.reservationVehicleKinds ?? [],
      hoursMode: reservationService?.reservationHoursMode ?? 'opening',
      scheduleCount: schedules.length,
      reservationHourCount: reservationRanges.length,
    });
    const takesReservations =
      reservationService?.enabled === true && readiness.ready && rateUsable;
    const graceMinutes =
      reservationService?.graceMinutes ?? DEFAULT_GRACE_MINUTES;

    return {
      schedules,
      reservationRate: takesReservations
        ? {
            name: rate.name,
            hourPriceArs: Number(rate.hourPriceArs),
            fractionPriceArs: Number(rate.fractionPriceArs),
            mediaEstadiaPriceArs: Number(rate.mediaEstadiaPriceArs),
            stayPriceArs: Number(rate.stayPriceArs),
          }
        : null,
      reservableSpots: takesReservations ? spots : null,
      reservation:
        takesReservations && reservationService
          ? {
              vehicleKinds: reservationService.reservationVehicleKinds,
              hoursMode: reservationService.reservationHoursMode,
              hours: effectiveReservationHours(
                reservationService.reservationHoursMode,
                schedules,
                reservationRanges,
              ),
              acceptanceMode: reservationService.acceptanceMode,
              freeCancelMinutes: reservationService.freeCancelMinutes,
              lateCancelRefundPct: reservationService.lateCancelRefundPct,
              earlyArrivalMinutes: reservationService.earlyArrivalMinutes,
              graceMinutes,
            }
          : null,
      occupied,
      reservedToday: todays.filter((reservation) =>
        reservationHoldsSpotNow(reservation, now, graceMinutes),
      ).length,
    };
  }
}

const DAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function sortSchedules(ranges: ScheduleRange[]): ScheduleRange[] {
  return [...ranges].sort(
    (left, right) =>
      DAY_ORDER.indexOf(left.day) - DAY_ORDER.indexOf(right.day) ||
      left.openMinute - right.openMinute,
  );
}

function coordinatesOf(tenant: PublicTenant) {
  return {
    latitude: Number(tenant.latitude),
    longitude: Number(tenant.longitude),
  };
}

function toParkingDto(
  tenant: PublicTenant,
  lot: LotData,
  now: Date,
): DriverParkingDto {
  const total = readCapacity(tenant.settings).total;
  return {
    id: tenant.id,
    name: tenant.name,
    address: tenant.address,
    ...coordinatesOf(tenant),
    availableSpots: availableSpots(total, lot.occupied, lot.reservedToday),
    totalSpots: total > 0 ? total : null,
    acceptsReservations: lot.reservationRate !== null,
    reservationHourPriceArs: lot.reservationRate?.hourPriceArs ?? null,
    reservationFractionPriceArs: lot.reservationRate?.fractionPriceArs ?? null,
    reservationVehicleKinds: lot.reservation?.vehicleKinds ?? null,
    reservationHours: lot.reservation
      ? sortSchedules(lot.reservation.hours)
      : null,
    reservationRules: lot.reservation
      ? {
          acceptanceMode: lot.reservation.acceptanceMode,
          freeCancelMinutes: lot.reservation.freeCancelMinutes,
          lateCancelRefundPct: lot.reservation.lateCancelRefundPct,
          earlyArrivalMinutes: lot.reservation.earlyArrivalMinutes,
          graceMinutes: lot.reservation.graceMinutes,
        }
      : null,
    openNow: isOpenAt(lot.schedules, now),
  };
}

function unprocessable(detail: string, instance: string, code: ErrorCode) {
  return new FormattedException(
    'Unprocessable Entity',
    HttpStatus.UNPROCESSABLE_ENTITY,
    detail,
    instance,
    code,
  );
}
