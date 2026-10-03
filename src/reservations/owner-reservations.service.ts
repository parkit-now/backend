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
  PaginatedOwnerReservationsDto,
} from './dto/owner-reservation.dto';
import { ReservationLifecycleService } from './reservation-lifecycle.service';
import { readPolicySnapshot } from './reservation-policy';

const WITH_DETAIL = {
  user: { select: { name: true } },
  payments: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.ReservationInclude;

const WITH_DRIVER = {
  user: { select: { name: true } },
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

  async get(tenantId: string, reservationId: string) {
    return this.detail(
      reservationId,
      `/tenants/${tenantId}/reservations/${reservationId}`,
    );
  }

  async accept(tenantId: string, reservationId: string) {
    await this.lifecycle.accept(tenantId, reservationId);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async reject(tenantId: string, reservationId: string, reason: string) {
    await this.lifecycle.reject(tenantId, reservationId, reason);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async cancel(tenantId: string, reservationId: string, reason: string) {
    await this.lifecycle.ownerCancel(tenantId, reservationId, reason);
    return this.detail(reservationId, instanceOf(tenantId, reservationId));
  }

  async retryRefund(tenantId: string, reservationId: string) {
    await this.lifecycle.retryRefund(tenantId, reservationId);
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
    code: `R-${row.id.replace(/-/g, '').slice(-6).toUpperCase()}`,
    status: row.status,
    vehiclePlate: row.vehiclePlate,
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
