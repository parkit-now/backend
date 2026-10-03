import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  ServiceCode,
  type MpAccountStatus,
} from '@prisma/client';
import { readCapacity } from '../entities/entity-settings';
import { findScheduleIssues } from '../schedules/schedule-issues';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import {
  FormattedException,
  FormattedExceptionWithValidation,
  ValidationErr,
} from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ReservationHoursDto } from './dto/reservation-hours.dto';
import { ServiceCatalogItemDto } from './dto/service-catalog-item.dto';
import { rangesOutsideOpening } from './reservation-hours';
import {
  computeReservationReadiness,
  type ReservationReadiness,
} from './reservation-readiness';
import { ServiceChangesQueryDto } from './dto/service-changes-query.dto';
import { ServiceDto } from './dto/service.dto';

type PrismaService_ = Prisma.ServiceGetPayload<Record<string, never>>;

function toDto(service: PrismaService_): ServiceDto {
  return { ...service };
}

const RULE_FIELDS = [
  'reservationVehicleKinds',
  'acceptanceMode',
  'approvalWindowMinutes',
  'freeCancelMinutes',
  'lateCancelRefundPct',
  'earlyArrivalMinutes',
  'graceMinutes',
] as const;

type ServiceRow = Pick<
  PrismaService_,
  | 'enabled'
  | 'reservationRateId'
  | 'reservableSpots'
  | 'reservationHoursMode'
  | (typeof RULE_FIELDS)[number]
>;

/** Fila sin guardar: los defaults de la columna (ver la migración). */
const DEFAULT_ROW: ServiceRow = {
  enabled: false,
  reservationRateId: null,
  reservableSpots: null,
  reservationVehicleKinds: [],
  reservationHoursMode: 'opening',
  acceptanceMode: 'auto',
  approvalWindowMinutes: 15,
  freeCancelMinutes: 60,
  lateCancelRefundPct: 0,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
};

export type UpdateServiceInput = {
  enabled?: boolean;
  reservationRateId?: string | null;
  reservableSpots?: number | null;
} & Partial<Pick<ServiceRow, (typeof RULE_FIELDS)[number]>>;

const DAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const SERVICES_PATH = '/tenants/:tenantId/services';
const HOURS_PATH = '/tenants/:tenantId/services/ADVANCE_RESERVATION/hours';

/** Lo que no sale de la fila `services` y hace falta para la readiness. */
type ReservationContext = {
  mpStatus: MpAccountStatus | null;
  capacityTotal: number;
  rateUsable: boolean;
  scheduleCount: number;
  reservationHourCount: number;
  upcomingPaidReservations: number;
};

function readinessOf(
  row: ServiceRow,
  ctx: ReservationContext,
): ReservationReadiness {
  return computeReservationReadiness({
    mpStatus: ctx.mpStatus,
    reservableSpots: row.reservableSpots,
    capacityTotal: ctx.capacityTotal,
    rateUsable: ctx.rateUsable,
    vehicleKinds: row.reservationVehicleKinds,
    hoursMode: row.reservationHoursMode,
    scheduleCount: ctx.scheduleCount,
    reservationHourCount: ctx.reservationHourCount,
  });
}

function toCatalogItem(
  code: ServiceCode,
  row: ServiceRow | undefined,
  ctx: ReservationContext,
): ServiceCatalogItemDto {
  const r = row ?? DEFAULT_ROW;
  return {
    code,
    enabled: r.enabled,
    reservationRateId: r.reservationRateId,
    reservableSpots: r.reservableSpots,
    reservationVehicleKinds: r.reservationVehicleKinds,
    reservationHoursMode: r.reservationHoursMode,
    acceptanceMode: r.acceptanceMode,
    approvalWindowMinutes: r.approvalWindowMinutes,
    freeCancelMinutes: r.freeCancelMinutes,
    lateCancelRefundPct: r.lateCancelRefundPct,
    earlyArrivalMinutes: r.earlyArrivalMinutes,
    graceMinutes: r.graceMinutes,
    readiness: readinessOf(r, ctx),
    upcomingPaidReservations: ctx.upcomingPaidReservations,
  };
}

type ServiceChangesResponse = {
  items: ServiceDto[];
  maxSeq: number;
};

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Datos de la readiness que viven fuera de la fila: cuenta de Mercado Pago
   * (global, se filtra a mano por tenant), capacidad, tarifa, horarios y
   * reservas futuras. Se carga una vez por request.
   */
  private async loadContext(
    rateId: string | null,
    now = new Date(),
  ): Promise<ReservationContext> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const [account, tenant, rate, scheduleCount, hourCount, upcoming] =
      await Promise.all([
        this.prisma.mpAccount.findUnique({
          where: { tenantId },
          select: { status: true },
        }),
        this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        }),
        rateId
          ? tenantPrisma.rate.findFirst({
              where: { id: rateId, deletedAt: null, isActive: true },
              select: { id: true },
            })
          : null,
        tenantPrisma.schedule.count(),
        tenantPrisma.reservationHour.count(),
        tenantPrisma.reservation.count({
          where: {
            // Pagas y por venir: las que esperan la aceptación del dueño
            // también tienen la plata cobrada.
            status: {
              in: [
                ReservationStatus.pending_approval,
                ReservationStatus.confirmed,
              ],
            },
            entryAt: { gt: now },
          },
        }),
      ]);
    return {
      mpStatus: account?.status ?? null,
      capacityTotal: readCapacity(tenant?.settings ?? {}).total,
      rateUsable: rate !== null,
      scheduleCount,
      reservationHourCount: hourCount,
      upcomingPaidReservations: upcoming,
    };
  }

  /**
   * Returns the full catalog (every ServiceCode) merged with the tenant's
   * stored rows. Codes without a row default to disabled and unconfigured.
   */
  async listServices(): Promise<ServiceCatalogItemDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rows = await tenantPrisma.service.findMany();
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const reservation = byCode.get(ServiceCode.ADVANCE_RESERVATION);
    const ctx = await this.loadContext(reservation?.reservationRateId ?? null);

    return Object.values(ServiceCode).map((code) =>
      toCatalogItem(code, byCode.get(code), ctx),
    );
  }

  async pullChanges(
    query: ServiceChangesQueryDto,
  ): Promise<ServiceChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();

    const items = await tenantPrisma.service.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  /**
   * Upsert the enabled state and, for ADVANCE_RESERVATION, the reservation
   * rate and reservable spots of a service code in the active tenant. Updates
   * the existing row (incrementing version) or inserts a new one with the
   * provided values (unspecified fields keep their defaults).
   */
  async updateService(
    code: string,
    data: UpdateServiceInput,
  ): Promise<ServiceCatalogItemDto> {
    if (!this.isServiceCode(code)) {
      throw new FormattedException(
        'Invalid service code',
        HttpStatus.BAD_REQUEST,
        `Unknown service code '${code}'.`,
        SERVICES_PATH,
        ErrorCodes.SERVICE_INVALID_CODE,
      );
    }
    const touchesReservationConfig =
      data.reservationRateId !== undefined ||
      data.reservableSpots !== undefined ||
      RULE_FIELDS.some((field) => data[field] !== undefined);
    if (touchesReservationConfig && code !== ServiceCode.ADVANCE_RESERVATION) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Only ADVANCE_RESERVATION takes reservation rules, rate and spots.',
        SERVICES_PATH,
        ErrorCodes.SERVICE_CONFIG_NOT_SUPPORTED,
      );
    }
    await this.assertReservationRateUsable(data.reservationRateId);

    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    await this.assertReservableSpotsFit(tenantId, data.reservableSpots);

    // Cómo va a quedar la fila: sirve para validar la activación con los datos
    // que se van a guardar y para armar la respuesta.
    const current = await tenantPrisma.service.findFirst({ where: { code } });
    const merged: ServiceRow = { ...(current ?? DEFAULT_ROW) };
    if (data.enabled !== undefined) merged.enabled = data.enabled;
    if (data.reservationRateId !== undefined)
      merged.reservationRateId = data.reservationRateId;
    if (data.reservableSpots !== undefined)
      merged.reservableSpots = data.reservableSpots;
    for (const field of RULE_FIELDS) {
      if (data[field] !== undefined) {
        Object.assign(merged, { [field]: data[field] });
      }
    }
    const ctx = await this.loadContext(merged.reservationRateId);

    // Activar exige la readiness completa; desactivar siempre se permite.
    if (data.enabled === true) {
      const { ready, missing } = readinessOf(merged, ctx);
      if (!ready) {
        throw new FormattedExceptionWithValidation(
          'Unprocessable Entity',
          HttpStatus.UNPROCESSABLE_ENTITY,
          `Reservations cannot be enabled yet: missing ${missing.join(', ')}.`,
          SERVICES_PATH,
          ErrorCodes.SERVICE_RESERVATION_NOT_READY,
          missing.map(
            (requirement) =>
              new ValidationErr(
                `readiness.${requirement}`,
                `${requirement} is required to accept reservations`,
                'required',
              ),
          ),
          { missing },
        );
      }
    }

    // Unchecked: incluye el escalar de la FK (reservationRateId).
    const updateData: Prisma.ServiceUncheckedUpdateManyInput = {
      version: { increment: 1 },
    };
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.reservationRateId !== undefined)
      updateData.reservationRateId = data.reservationRateId;
    if (data.reservableSpots !== undefined)
      updateData.reservableSpots = data.reservableSpots;
    for (const field of RULE_FIELDS) {
      if (data[field] !== undefined) {
        Object.assign(updateData, { [field]: data[field] });
      }
    }

    const updated = await tenantPrisma.service.updateMany({
      where: { tenantId, code },
      data: updateData,
    });

    let row: ServiceRow;
    if (updated.count === 0) {
      row = await tenantPrisma.service.create({
        data: {
          ...merged,
          code,
          // tenantId is injected by prismaForTenant(...)
        } as Prisma.ServiceUncheckedCreateInput,
      });
    } else {
      row = await tenantPrisma.service.findFirstOrThrow({ where: { code } });
    }

    return toCatalogItem(code, row, ctx);
  }

  /** Horario de reservas: el modo y los rangos propios (vacíos en `opening`). */
  async getReservationHours(): Promise<ReservationHoursDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const [service, ranges] = await Promise.all([
      tenantPrisma.service.findFirst({
        where: { code: ServiceCode.ADVANCE_RESERVATION },
        select: { reservationHoursMode: true },
      }),
      tenantPrisma.reservationHour.findMany({
        select: { day: true, openMinute: true, closeMinute: true },
      }),
    ]);
    return {
      mode: service?.reservationHoursMode ?? DEFAULT_ROW.reservationHoursMode,
      ranges: ranges.sort(
        (left, right) =>
          DAY_ORDER.indexOf(left.day) - DAY_ORDER.indexOf(right.day) ||
          left.openMinute - right.openMinute,
      ),
    };
  }

  /**
   * Reemplaza el horario de reservas completo. En `custom` los rangos tienen
   * que ser válidos, no superponerse y caer dentro del horario de apertura; en
   * `opening` se borran los propios. Modo y rangos cambian juntos, en una
   * transacción.
   */
  async putReservationHours(
    dto: ReservationHoursDto,
  ): Promise<ReservationHoursDto> {
    const ranges = dto.mode === 'custom' ? dto.ranges : [];
    const issues = findScheduleIssues(ranges);
    if (issues.length > 0) {
      throw new FormattedExceptionWithValidation(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Reservation hours have invalid or overlapping ranges.',
        HOURS_PATH,
        ErrorCodes.RESERVATION_HOURS_INVALID,
        issues.map(
          (issue) =>
            new ValidationErr(
              `ranges.${issue.index}`,
              issue.kind === 'overlap'
                ? `overlaps with ranges.${issue.overlapsWith}`
                : 'closeMinute must be greater than openMinute',
              issue.kind,
            ),
        ),
      );
    }

    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    if (ranges.length > 0) {
      const schedules = await tenantPrisma.schedule.findMany({
        select: { day: true, openMinute: true, closeMinute: true },
      });
      const outside = rangesOutsideOpening(ranges, schedules);
      if (outside.length > 0) {
        throw new FormattedExceptionWithValidation(
          'Unprocessable Entity',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Reservation hours must fall within the opening hours.',
          HOURS_PATH,
          ErrorCodes.RESERVATION_HOURS_OUTSIDE_OPENING,
          outside.map(
            (index) =>
              new ValidationErr(
                `ranges.${index}`,
                'outside the opening hours',
                'outside_opening',
              ),
          ),
        );
      }
    }

    // El cliente de la transacción no admite la extensión por tenant: el
    // `tenantId` va explícito en cada operación.
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.service.updateMany({
        where: { tenantId, code: ServiceCode.ADVANCE_RESERVATION },
        data: { reservationHoursMode: dto.mode, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        await tx.service.create({
          data: {
            tenantId,
            code: ServiceCode.ADVANCE_RESERVATION,
            reservationHoursMode: dto.mode,
          },
        });
      }
      await tx.reservationHour.deleteMany({ where: { tenantId } });
      if (ranges.length > 0) {
        await tx.reservationHour.createMany({
          data: ranges.map((range) => ({
            tenantId,
            day: range.day,
            openMinute: range.openMinute,
            closeMinute: range.closeMinute,
          })),
        });
      }
    });
    return this.getReservationHours();
  }

  /**
   * La tarifa tiene que ser de ESTA playa, no estar borrada y estar activa.
   * La FK compuesta ya impide apuntar a otro tenant, pero un 400 con código
   * es más útil para la web que un error de FK, y la FK no mira `deletedAt`.
   */
  /**
   * El cupo de reservas es un subconjunto de la capacidad de la playa
   * (`tenant.settings.capacity.total`): no puede superarla. Sin capacidad
   * declarada (0) no hay contra qué validar y se acepta.
   */
  private async assertReservableSpotsFit(
    tenantId: string,
    reservableSpots: number | null | undefined,
  ): Promise<void> {
    if (!reservableSpots) return;
    // `Tenant` es global: se lee con el cliente base, por id.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const capacity = readCapacity(tenant?.settings ?? {}).total;
    if (capacity > 0 && reservableSpots > capacity) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        `Reservable spots (${reservableSpots}) exceed the lot capacity (${capacity}).`,
        SERVICES_PATH,
        ErrorCodes.SERVICE_RESERVABLE_SPOTS_EXCEED_CAPACITY,
      );
    }
  }

  private async assertReservationRateUsable(
    rateId: string | null | undefined,
  ): Promise<void> {
    if (!rateId) return;
    const found = await this.prisma.getTenantClient().rate.findFirst({
      where: { id: rateId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!found) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Reservation rate not found in this entity.',
        SERVICES_PATH,
        ErrorCodes.SERVICE_RESERVATION_RATE_NOT_FOUND,
      );
    }
  }

  private isServiceCode(value: string): value is ServiceCode {
    return (Object.values(ServiceCode) as string[]).includes(value);
  }
}
