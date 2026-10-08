import { HttpStatus, Injectable } from '@nestjs/common';
import { BranchStatus, Prisma, ServiceCode, type User } from '@prisma/client';
import { readCapacity } from '../entities/entity-settings';
import { calcStayPrice } from '../entries/pricing';
import { effectiveReservationHours } from '../services/reservation-hours';
import { computeReservationReadiness } from '../services/reservation-readiness';
import { PrismaService } from '../database/prisma.service';
import { prismaForTenant } from '../database/prisma-tenant';
import {
  RESERVED_HELD_SELECT,
  reservedTodayWhere,
} from '../reservations/reservation-capacity';
import {
  buildPolicySnapshot,
  DEFAULT_POLICY_SNAPSHOT,
  type PolicySnapshot,
} from '../reservations/reservation-policy';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  DEFAULT_GRACE_MINUTES,
  RESERVATION_MAX_DAYS_AHEAD,
  availableSpots,
  boundingBox,
  countReservedHeld,
  distanceMeters,
  isOpenAt,
  isOpenThroughout,
  reservationWindowProblem,
  type ScheduleRange,
  type WindowProblem,
} from './driver-rules';
import {
  DriverNearbyParkingDto,
  DriverParkingDetailDto,
  DriverParkingDto,
  DriverParkingSearchResultDto,
} from './dto/driver-parking.dto';
import {
  DEFAULT_RADIUS_METERS,
  NearbyParkingsQueryDto,
} from './dto/nearby-parkings-query.dto';
import {
  SEARCH_MAX_RESULTS,
  SEARCH_MIN_LENGTH,
  SearchParkingsQueryDto,
} from './dto/search-parkings-query.dto';
import { tenantSearchWhere } from '../utils/search/tenant-search';
import { CreateQuoteDto, QuoteDto } from './dto/quote.dto';
import { DriverVehiclesService } from './driver-vehicles.service';

const MAX_RESULTS = 50;
const SEARCH_CANDIDATES = 200;

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
    vehicleCategories: string[];
    hoursMode: string;
    /** Horario efectivo: el propio en `custom`, el de apertura en `opening`. */
    hours: ScheduleRange[];
    acceptanceMode: string;
    freeCancelMinutes: number;
    lateCancelRefundPct: number;
    earlyArrivalMinutes: number;
    graceMinutes: number;
    approvalWindowMinutes: number;
    earlyArrivalMaxMinutes: number;
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
        deletedAt: null,
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

  /**
   * Búsqueda por nombre o dirección (misma regla que el listado del admin).
   * Sólo playas activas. Con coordenadas ordena por distancia (las playas sin
   * ubicación van al final); sin ellas, por nombre.
   */
  async searchByName(
    query: SearchParkingsQueryDto,
    now = new Date(),
  ): Promise<DriverParkingSearchResultDto[]> {
    const term = query.q.trim();
    if (term.length < SEARCH_MIN_LENGTH) return [];
    const center =
      query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : null;

    const tenants = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        status: BranchStatus.active,
        ...tenantSearchWhere(term),
      },
      select: PUBLIC_TENANT_SELECT,
      orderBy: { name: 'asc' },
      // Tope de candidatos: el orden por distancia se resuelve en memoria.
      take: SEARCH_CANDIDATES,
    });

    const ranked = tenants.map((tenant) => ({
      tenant,
      distance:
        center && tenant.latitude !== null && tenant.longitude !== null
          ? distanceMeters(center, coordinatesOf(tenant))
          : null,
    }));
    if (center) {
      ranked.sort((left, right) => {
        if (left.distance === null) return right.distance === null ? 0 : 1;
        if (right.distance === null) return -1;
        return left.distance - right.distance;
      });
    }

    return Promise.all(
      ranked.slice(0, SEARCH_MAX_RESULTS).map(async ({ tenant, distance }) => ({
        ...toParkingDto(tenant, await this.loadLotData(tenant, now), now),
        distanceMeters: distance === null ? null : Math.round(distance),
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
    let vehicleCategory: string | undefined;
    if (dto.vehiclePlate) {
      const kind = await this.driverVehicles.findOwnedCategory(
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
      vehicleCategory = kind;
    }
    return (
      await this.quoteForReservation(parkingId, dto, now, vehicleCategory)
    ).quote;
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
    vehicleCategory?: string,
  ): Promise<{
    quote: QuoteDto;
    reservableSpots: number;
    /** Reglas de la playa a copiar a la reserva (`policySnapshot`). */
    policy: PolicySnapshot;
  }> {
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
    if (
      rules &&
      vehicleCategory &&
      !rules.vehicleCategories.includes(vehicleCategory)
    ) {
      throw unprocessable(
        `This parking lot does not take reservations for '${vehicleCategory}' vehicles.`,
        instance,
        ErrorCodes.RESERVATION_VEHICLE_CATEGORY_NOT_ACCEPTED,
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
    return {
      quote,
      reservableSpots: lot.reservableSpots ?? 0,
      policy: rules
        ? buildPolicySnapshot(rules)
        : { ...DEFAULT_POLICY_SNAPSHOT },
    };
  }

  /** Viva, activa y con ubicación publicada; si no, para el conductor no existe. */
  private async findPublicTenant(parkingId: string): Promise<PublicTenant> {
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        id: parkingId,
        // Sin esto, un conductor podría RESERVAR Y PAGAR en una playa dada de
        // baja: es el único camino del producto donde entra plata de alguien
        // que no es miembro del tenant, así que el filtro no es cosmético.
        deletedAt: null,
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
          reservationVehicleCategories: true,
          reservationHoursMode: true,
          acceptanceMode: true,
          approvalWindowMinutes: true,
          freeCancelMinutes: true,
          lateCancelRefundPct: true,
          earlyArrivalMinutes: true,
          graceMinutes: true,
          earlyArrivalMaxMinutes: true,
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
      tenantPrisma.entry.count({ where: { leftAt: null, deletedAt: null } }),
      // Reservas de hoy que retienen lugar: las que todavía no vencieron lo
      // ocupan (SCRUM-261) hasta que el auto entra (ver countReservedHeld).
      tenantPrisma.reservation.findMany({
        where: reservedTodayWhere(now),
        select: RESERVED_HELD_SELECT,
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
      vehicleCategories: reservationService?.reservationVehicleCategories ?? [],
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
              vehicleCategories:
                reservationService.reservationVehicleCategories,
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
              approvalWindowMinutes:
                reservationService.approvalWindowMinutes ??
                DEFAULT_POLICY_SNAPSHOT.approvalWindowMinutes,
              earlyArrivalMaxMinutes: reservationService.earlyArrivalMaxMinutes,
            }
          : null,
      occupied,
      reservedToday: countReservedHeld(todays, now),
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
    reservationVehicleCategories: lot.reservation?.vehicleCategories ?? null,
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
