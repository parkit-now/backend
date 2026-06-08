import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ServiceCode } from '@prisma/client';
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
   * stored rows. Codes without a row default to disabled.
   */
  async listServices(): Promise<ServiceCatalogItemDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rows = await tenantPrisma.service.findMany();
    const byCode = new Map(rows.map((r) => [r.code, r]));

    return Object.values(ServiceCode).map((code) => {
      const row = byCode.get(code);
      return {
        code,
        enabled: row?.enabled ?? false,
        spots: row?.spots ?? 0,
      };
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
   * Upsert the enabled state and/or spot count for a service code in the
   * active tenant. Updates the existing row (incrementing version) or inserts
   * a new one with the provided values (defaulting the unspecified field).
   */
  async updateService(
    code: string,
    data: { enabled?: boolean; spots?: number },
  ): Promise<ServiceCatalogItemDto> {
    if (!this.isServiceCode(code)) {
      throw new FormattedException(
        'Invalid service code',
        HttpStatus.BAD_REQUEST,
        `Unknown service code '${code}'.`,
        '/tenants/:tenantId/services',
        ErrorCodes.SERVICE_INVALID_CODE,
      );
    }

    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const updateData: Prisma.ServiceUpdateManyMutationInput = {
      version: { increment: 1 },
    };
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.spots !== undefined) updateData.spots = data.spots;

    const updated = await tenantPrisma.service.updateMany({
      where: { tenantId, code },
      data: updateData,
    });

    let row: { enabled: boolean; spots: number };
    if (updated.count === 0) {
      row = await tenantPrisma.service.create({
        data: {
          code,
          enabled: data.enabled ?? false,
          spots: data.spots ?? 0,
          // tenantId is injected by prismaForTenant(...)
        } as Prisma.ServiceUncheckedCreateInput,
      });
    } else {
      row = await tenantPrisma.service.findFirstOrThrow({ where: { code } });
    }

    return { code, enabled: row.enabled, spots: row.spots };
  }

  private isServiceCode(value: string): value is ServiceCode {
    return (Object.values(ServiceCode) as string[]).includes(value);
  }
}
