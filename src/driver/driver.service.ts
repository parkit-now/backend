import { HttpStatus, Injectable } from '@nestjs/common';
import { BranchStatus, Prisma, ServiceCode } from '@prisma/client';
import { readCapacity } from '../entities/entity-settings';
import { calcStayPrice } from '../entries/pricing';
import { PrismaService } from '../database/prisma.service';
import { prismaForTenant } from '../database/prisma-tenant';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  RESERVATION_MAX_DAYS_AHEAD,
  boundingBox,
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
} from './dto/driver-parking.dto';
import {
  DEFAULT_RADIUS_METERS,
  NearbyParkingsQueryDto,
} from './dto/nearby-parkings-query.dto';
import { CreateQuoteDto, QuoteDto } from './dto/quote.dto';

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
  occupied: number;
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
  constructor(private readonly prisma: PrismaService) {}

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
        ...toParkingDto(tenant, await this.loadLotData(tenant.id), now),
        distanceMeters: Math.round(distance),
      })),
    );
  }

  async findOne(
    parkingId: string,
    now = new Date(),
  ): Promise<DriverParkingDetailDto> {
    const tenant = await this.findPublicTenant(parkingId);
    const lot = await this.loadLotData(tenant.id);
    return {
      ...toParkingDto(tenant, lot, now),
      schedules: [...lot.schedules].sort(
        (left, right) =>
          DAY_ORDER.indexOf(left.day) - DAY_ORDER.indexOf(right.day) ||
          left.openMinute - right.openMinute,
      ),
      reservationMaxDaysAhead: RESERVATION_MAX_DAYS_AHEAD,
    };
  }

  async quote(
    parkingId: string,
    dto: CreateQuoteDto,
    now = new Date(),
  ): Promise<QuoteDto> {
    const tenant = await this.findPublicTenant(parkingId);
    const lot = await this.loadLotData(tenant.id);
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

    const durationMinutes = Math.round(
      (exitAt.getTime() - entryAt.getTime()) / 60_000,
    );
    return {
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

  private async loadLotData(tenantId: string): Promise<LotData> {
    const tenantPrisma = prismaForTenant(this.prisma, tenantId);
    const [schedules, reservationService, occupied] = await Promise.all([
      tenantPrisma.schedule.findMany({
        select: { day: true, openMinute: true, closeMinute: true },
      }),
      tenantPrisma.service.findFirst({
        where: { code: ServiceCode.ADVANCE_RESERVATION },
        select: {
          enabled: true,
          reservableSpots: true,
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
      tenantPrisma.entry.count({ where: { leftAt: null } }),
    ]);

    const rate = reservationService?.reservationRate;
    const spots = reservationService?.reservableSpots ?? 0;
    const takesReservations =
      reservationService?.enabled === true &&
      !!rate &&
      rate.isActive &&
      !rate.deletedAt &&
      spots > 0;

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
      occupied,
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
    availableSpots: total > 0 ? Math.max(total - lot.occupied, 0) : null,
    totalSpots: total > 0 ? total : null,
    acceptsReservations: lot.reservationRate !== null,
    reservationHourPriceArs: lot.reservationRate?.hourPriceArs ?? null,
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
