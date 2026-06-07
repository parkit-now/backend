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
    const enabledByCode = new Map(rows.map((r) => [r.code, r.enabled]));

    return Object.values(ServiceCode).map((code) => ({
      code,
      enabled: enabledByCode.get(code) ?? false,
    }));
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
   * Upsert the enabled state for a service code in the active tenant.
   * Updates the existing row (incrementing version) or inserts a new one.
   */
  async toggleService(
    code: string,
    enabled: boolean,
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

    const updated = await tenantPrisma.service.updateMany({
      where: { tenantId, code },
      data: { enabled, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      await tenantPrisma.service.create({
        data: {
          code,
          enabled,
          // tenantId is injected by prismaForTenant(...)
        } as Prisma.ServiceUncheckedCreateInput,
      });
    }

    return { code, enabled };
  }

  private isServiceCode(value: string): value is ServiceCode {
    return (Object.values(ServiceCode) as string[]).includes(value);
  }
}
