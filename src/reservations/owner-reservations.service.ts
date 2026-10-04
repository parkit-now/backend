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
  ReservationMatchResponseDto,
} from './dto/owner-reservation.dto';
import {
  ARRIVAL_SELECT,
  arrivalCandidatesWhere,
  arrivalWindow,
  pickReservationForArrival,
  prepaidAmountOf,
  reservationCode,
} from './reservation-checkin';
import {
  ReservationLifecycleService,
  type ReservationActor,
} from './reservation-lifecycle.service';
import { readPolicySnapshot } from './reservation-policy';

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
   * así que lo que muestra el banner es lo que se vincula.
   */
  async match(
    tenantId: string,
    plate: string,
    now = new Date(),
  ): Promise<ReservationMatchResponseDto> {
    const where = arrivalCandidatesWhere(tenantId, plate, now);
    if (!where) return { reservation: null };
    const candidates = await this.prisma
      .getTenantClient()
      .reservation.findMany({ where, select: ARRIVAL_SELECT });
    const chosen = pickReservationForArrival(candidates, now);
    if (!chosen) return { reservation: null };
    const window = arrivalWindow(chosen);
    return {
      reservation: {
        id: chosen.id,
        code: reservationCode(chosen.id),
        status: chosen.status,
        vehiclePlate: chosen.vehiclePlate,
        vehicleCategory: isVehicleCategory(chosen.vehicleCategory)
          ? chosen.vehicleCategory
          : null,
        driverName: chosen.user.name,
        entryAt: chosen.entryAt.toISOString(),
        exitAt: chosen.exitAt.toISOString(),
        arrivalFrom: window.from.toISOString(),
        arrivalUntil: window.until.toISOString(),
        totalArs: Number(chosen.totalArs),
        prepaidAmountArs: prepaidAmountOf(chosen),
      },
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
    stay: stayOf(row.entry),
  };
}

function stayOf(
  entry: ReservationWithDriver['entry'],
): OwnerReservationStayDto | null {
  if (!entry) return null;
  return {
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
