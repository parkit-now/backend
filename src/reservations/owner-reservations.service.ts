import { isVehicleCategory } from '../vehicle-categories/vehicle-categories';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizePlate } from '../driver/driver-rules';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { resolvePagination } from '../utils/pagination/pagination-query.dto';
import {
  ListOwnerReservationsQueryDto,
  OwnerReservationDetailDto,
  OwnerReservationDto,
  OwnerReservationStayDto,
  PaginatedOwnerReservationsDto,
  ReservationMatchDto,
  ReservationMatchResponseDto,
} from './dto/owner-reservation.dto';
import {
  ARRIVAL_SELECT,
  arrivalCandidatesWhere,
  arrivalWindow,
  fallbackEarlyArrivalMax,
  findUpcomingReservation,
  linkableWindow,
  pickReservationForArrival,
  prepaidAmountOf,
  reservationCode,
  stayArrival,
  type ArrivalCandidate,
  type ArrivalClassification,
} from './reservation-checkin';
import {
  ReservationLifecycleService,
  type ReservationActor,
} from './reservation-lifecycle.service';
import {
  DEFAULT_POLICY_SNAPSHOT,
  readPolicySnapshot,
} from './reservation-policy';

/** El ingreso de la caja vinculado (fase 6). */
const STAY_SELECT = {
  select: {
    id: true,
    enteredAt: true,
    leftAt: true,
    amountPaid: true,
    prepaidAmountArs: true,
  },
} satisfies Prisma.EntryDefaultArgs;

const WITH_DETAIL = {
  user: { select: { name: true } },
  payments: { orderBy: { createdAt: 'desc' } },
  entry: STAY_SELECT,
} satisfies Prisma.ReservationInclude;

const WITH_DRIVER = {
  user: { select: { name: true } },
  entry: STAY_SELECT,
} satisfies Prisma.ReservationInclude;

type ReservationWithDriver = Prisma.ReservationGetPayload<{
  include: typeof WITH_DRIVER;
}>;
type ReservationWithDetail = Prisma.ReservationGetPayload<{
  include: typeof WITH_DETAIL;
}>;

/**
 * Reservas de una playa vistas por su dueño u operador. Las lecturas van por el
 * cliente tenant (`getTenantClient()`, que inyecta el `WHERE tenant_id`); las
 * transiciones las hace el ciclo de vida, que recibe el `tenantId` de la ruta
 * y lo usa en cada `updateMany`.
 */
@Injectable()
export class OwnerReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ReservationLifecycleService,
  ) {}

  async list(
    query: ListOwnerReservationsQueryDto,
  ): Promise<PaginatedOwnerReservationsDto> {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const tenantPrisma = this.prisma.getTenantClient();
    const where = listWhere(query);

    const [rows, total] = await Promise.all([
      tenantPrisma.reservation.findMany({
        where,
        include: WITH_DRIVER,
        orderBy: [{ entryAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      tenantPrisma.reservation.count({ where }),
    ]);
    return { items: rows.map(toDto), total, page, pageSize };
  }

  /**
   * La reserva que corresponde a un auto que llega ahora con esa patente: la
   * misma regla que aplica el ingreso al vincular (`claimReservationForArrival`),
   * así que lo que muestra el banner es lo que se vincula. Incluye las
   * llegadas anticipadas (hasta el tope) y las tardías (hasta `exitAt`), con
   * `arrival` para que la caja avise.
   *
   * Si no hay ninguna vinculable, `upcoming` trae la próxima reserva
   * confirmada de esa patente en las próximas 24 h (llegó demasiado
   * temprano): la caja muestra "Esta patente tiene una reserva hoy a las
   * HH:MM" y el ingreso queda como estadía común. Va en un campo aparte y no en `reservation`
   * para que una caja vieja, que vincula todo lo que viene en `reservation`,
   * no muestre un banner de algo que el backend no va a vincular.
   */
  async match(
    tenantId: string,
    plate: string,
    now = new Date(),
  ): Promise<ReservationMatchResponseDto> {
    const where = arrivalCandidatesWhere(tenantId, plate, now);
    if (!where) return { reservation: null, upcoming: null };
    const db = this.prisma.getTenantClient();
    const candidates = await db.reservation.findMany({
      where,
      select: ARRIVAL_SELECT,
    });
    const fallback =
      candidates.length > 0
        ? await fallbackEarlyArrivalMax(this.prisma, tenantId, candidates)
        : DEFAULT_POLICY_SNAPSHOT.earlyArrivalMaxMinutes;
    const chosen = pickReservationForArrival(candidates, now, null, fallback);
    if (chosen) {
      return {
        reservation: toMatchDto(chosen, chosen.classification, fallback),
        upcoming: null,
      };
    }
    // El cliente base con `tenantId` explícito (el extendido no encaja en los
    // tipos de transacción que comparten estas funciones con el ingreso).
    const upcoming = await findUpcomingReservation(
      this.prisma,
      tenantId,
      plate,
      now,
    );
    if (!upcoming) return { reservation: null, upcoming: null };
    const upcomingFallback = await fallbackEarlyArrivalMax(
      this.prisma,
      tenantId,
      [upcoming],
    );
    return {
      reservation: null,
      upcoming: toMatchDto(upcoming, upcoming.classification, upcomingFallback),
    };
  }

  async get(tenantId: string, reservationId: string) {
    return this.detail(
      reservationId,
      `/tenants/${tenantId}/reservations/${reservationId}`,
    );
  }

  async accept(
    tenantId: string,
    reservationId: string,
    actor: ReservationActor,
  ) {
    await this.lifecycle.accept(tenantId, reservationId, actor);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async reject(
    tenantId: string,
    reservationId: string,
    reason: string,
    actor: ReservationActor,
  ) {
    await this.lifecycle.reject(tenantId, reservationId, reason, actor);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async cancel(
    tenantId: string,
    reservationId: string,
    reason: string,
    actor: ReservationActor,
  ) {
    await this.lifecycle.ownerCancel(tenantId, reservationId, reason, actor);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async retryRefund(
    tenantId: string,
    reservationId: string,
    actor: ReservationActor,
  ) {
    await this.lifecycle.retryRefund(tenantId, reservationId, actor);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  private async detail(
    reservationId: string,
    instance: string,
  ): Promise<OwnerReservationDetailDto> {
    const row = await this.prisma.getTenantClient().reservation.findFirst({
      where: { id: reservationId },
      include: WITH_DETAIL,
    });
    if (!row) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Reservation not found.',
        instance,
        ErrorCodes.RESERVATION_NOT_FOUND,
      );
    }
    return toDetailDto(row);
  }
}

function toMatchDto(
  row: ArrivalCandidate,
  classification: ArrivalClassification,
  fallbackEarlyMaxMinutes: number,
): ReservationMatchDto {
  const window = arrivalWindow(row);
  const linkable = linkableWindow(row, fallbackEarlyMaxMinutes);
  const isLinkable =
    classification.arrival === 'early' ||
    classification.arrival === 'on_time' ||
    classification.arrival === 'late';
  return {
    id: row.id,
    code: reservationCode(row.id),
    status: row.status,
    vehiclePlate: row.vehiclePlate,
    vehicleCategory: isVehicleCategory(row.vehicleCategory)
      ? row.vehicleCategory
      : null,
    driverName: row.user.name,
    entryAt: row.entryAt.toISOString(),
    exitAt: row.exitAt.toISOString(),
    arrivalFrom: window.from.toISOString(),
    arrivalUntil: window.until.toISOString(),
    linkableFrom: linkable.from.toISOString(),
    linkableUntil: linkable.until.toISOString(),
    totalArs: Number(row.totalArs),
    prepaidAmountArs: prepaidAmountOf(row),
    arrival: classification.arrival as ReservationMatchDto['arrival'],
    linkable: isLinkable,
    minutesEarly: classification.minutesEarly,
    minutesLate: classification.minutesLate,
  };
}

const instanceOf = (tenantId: string, reservationId: string) =>
  `/tenants/${tenantId}/reservations/${reservationId}`;

function listWhere(
  query: ListOwnerReservationsQueryDto,
): Prisma.ReservationWhereInput {
  const where: Prisma.ReservationWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.from || query.to) {
    where.entryAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  const plate = query.q ? normalizePlate(query.q) : '';
  if (plate) where.vehiclePlate = { contains: plate };
  return where;
}

function toDto(row: ReservationWithDriver): OwnerReservationDto {
  const iso = (value: Date | null) => value?.toISOString() ?? null;
  const num = (value: Prisma.Decimal | null) =>
    value === null ? null : Number(value);
  return {
    id: row.id,
    code: reservationCode(row.id),
    status: row.status,
    vehiclePlate: row.vehiclePlate,
    vehicleCategory: isVehicleCategory(row.vehicleCategory)
      ? row.vehicleCategory
      : null,
    driverName: row.user.name,
    entryAt: row.entryAt.toISOString(),
    exitAt: row.exitAt.toISOString(),
    totalArs: Number(row.totalArs),
    rateName: row.rateSnapshotName,
    createdAt: row.createdAt.toISOString(),
    holdExpiresAt: iso(row.holdExpiresAt),
    paidAt: iso(row.paidAt),
    approvalDeadlineAt: iso(row.approvalDeadlineAt),
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    reason: row.reason,
    refundStatus: row.refundStatus,
    refundedAmountArs: num(row.refundedAmountArs),
    refundError: row.refundError,
    policy: readPolicySnapshot(row.policySnapshot),
    stay: stayOf(row, row.entry),
  };
}

function stayOf(
  reservation: { entryAt: Date; policySnapshot: unknown },
  entry: ReservationWithDriver['entry'],
): OwnerReservationStayDto | null {
  if (!entry) return null;
  return {
    ...stayArrival(reservation, entry.enteredAt),
    entryId: entry.id,
    enteredAt: entry.enteredAt.toISOString(),
    leftAt: entry.leftAt?.toISOString() ?? null,
    excessChargedArs:
      entry.leftAt && entry.amountPaid !== null
        ? Number(entry.amountPaid)
        : null,
    prepaidAmountArs:
      entry.prepaidAmountArs === null ? null : Number(entry.prepaidAmountArs),
  };
}

function toDetailDto(row: ReservationWithDetail): OwnerReservationDetailDto {
  return {
    ...toDto(row),
    refundAttempts: row.refundAttempts,
    refundRequestedArs:
      row.refundRequestedArs === null ? null : Number(row.refundRequestedArs),
    refundRequestedAt: row.refundRequestedAt?.toISOString() ?? null,
    payments: row.payments.map((payment) => ({
      id: payment.id,
      status: payment.status,
      amountArs: Number(payment.amountArs),
      provider: payment.provider,
      providerPaymentId: payment.providerPaymentId,
      providerStatus: payment.providerStatus,
      providerStatusDetail: payment.providerStatusDetail,
      approvedAt: payment.approvedAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
    })),
  };
}
