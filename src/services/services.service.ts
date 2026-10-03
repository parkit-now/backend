import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ServiceCode } from '@prisma/client';
import { readCapacity } from '../entities/entity-settings';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ServiceCatalogItemDto } from './dto/service-catalog-item.dto';
import { ServiceChangesQueryDto } from './dto/service-changes-query.dto';
import { ServiceDto } from './dto/service.dto';

type PrismaService_ = Prisma.ServiceGetPayload<Record<string, never>>;

function toDto(service: PrismaService_): ServiceDto {
  return { ...service };
}

type ServiceRow = Pick<
  PrismaService_,
  'enabled' | 'reservationRateId' | 'reservableSpots'
>;

export type UpdateServiceInput = {
  enabled?: boolean;
  reservationRateId?: string | null;
  reservableSpots?: number | null;
};

const SERVICES_PATH = '/tenants/:tenantId/services';

function toCatalogItem(
  code: ServiceCode,
  row: ServiceRow | undefined,
): ServiceCatalogItemDto {
  return {
    code,
    enabled: row?.enabled ?? false,
    reservationRateId: row?.reservationRateId ?? null,
    reservableSpots: row?.reservableSpots ?? null,
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
   * Returns the full catalog (every ServiceCode) merged with the tenant's
   * stored rows. Codes without a row default to disabled and unconfigured.
   */
  async listServices(): Promise<ServiceCatalogItemDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rows = await tenantPrisma.service.findMany();
    const byCode = new Map(rows.map((r) => [r.code, r]));

    return Object.values(ServiceCode).map((code) => {
      const row = byCode.get(code);
      return toCatalogItem(code, row);
    });
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
      data.reservableSpots !== undefined;
    if (touchesReservationConfig && code !== ServiceCode.ADVANCE_RESERVATION) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Only ADVANCE_RESERVATION takes a reservation rate and spots.',
        SERVICES_PATH,
        ErrorCodes.SERVICE_CONFIG_NOT_SUPPORTED,
      );
    }
    await this.assertReservationRateUsable(data.reservationRateId);

    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    await this.assertReservableSpotsFit(tenantId, data.reservableSpots);

    // Unchecked: incluye el escalar de la FK (reservationRateId).
    const updateData: Prisma.ServiceUncheckedUpdateManyInput = {
      version: { increment: 1 },
    };
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.reservationRateId !== undefined)
      updateData.reservationRateId = data.reservationRateId;
    if (data.reservableSpots !== undefined)
      updateData.reservableSpots = data.reservableSpots;

    const updated = await tenantPrisma.service.updateMany({
      where: { tenantId, code },
      data: updateData,
    });

    let row: ServiceRow;
    if (updated.count === 0) {
      row = await tenantPrisma.service.create({
        data: {
          code,
          enabled: data.enabled ?? false,
          reservationRateId: data.reservationRateId ?? null,
          reservableSpots: data.reservableSpots ?? null,
          // tenantId is injected by prismaForTenant(...)
        } as Prisma.ServiceUncheckedCreateInput,
      });
    } else {
      row = await tenantPrisma.service.findFirstOrThrow({ where: { code } });
    }

    return toCatalogItem(code, row);
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
