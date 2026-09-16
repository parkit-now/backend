import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateRateDto } from './dto/create-rate.dto';
import { ListRatesQueryDto } from './dto/list-rates-query.dto';
import { RateDto } from './dto/rate.dto';
import { RateChangesQueryDto } from './dto/rate-changes-query.dto';
import { UpdateRateDto } from './dto/update-rate.dto';

type PrismaRate = Prisma.RateGetPayload<Record<string, never>>;

function toDto(rate: PrismaRate): RateDto {
  return {
    ...rate,
    hourPriceArs: Number(rate.hourPriceArs),
    stayPriceArs: Number(rate.stayPriceArs),
    fractionPriceArs: Number(rate.fractionPriceArs),
    mediaEstadiaPriceArs: Number(rate.mediaEstadiaPriceArs),
  };
}

type RateChangesResponse = {
  items: RateDto[];
  maxSeq: number;
};

@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createRate(data: CreateRateDto): Promise<RateDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rate = await tenantPrisma.rate.create({
      data: {
        id: data.id,
        name: data.name,
        hourPriceArs: data.hourPriceArs,
        stayPriceArs: data.stayPriceArs,
        fractionPriceArs: data.fractionPriceArs,
        mediaEstadiaPriceArs: data.mediaEstadiaPriceArs,
        autoFractionPrice: data.autoFractionPrice ?? false,
        shortcutNumber: data.shortcutNumber ?? null,
        // tenantId is injected by prismaForTenant(...)
      } as Prisma.RateUncheckedCreateInput,
    });
    return toDto(rate);
  }

  async listRates(query: ListRatesQueryDto): Promise<RateDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    // Soft-deleted rates are never listed. This is independent of
    // `includeInactive`: `isActive: false` means "deactivated" (still visible
    // and reactivable in the owner panel), `deletedAt` means "deleted".
    const where: Prisma.RateWhereInput = { deletedAt: null };

    if (!query.includeInactive) {
      where.isActive = true;
    }

    const rates = await tenantPrisma.rate.findMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
    return rates.map(toDto);
  }

  /**
   * Incremental sync feed. Deliberately does NOT filter `deletedAt`: shipping
   * soft-deleted rows with a non-null `deletedAt` is precisely how a deletion
   * reaches offline clients. Mirrors `VehiclesService.pullCatalogChanges`.
   */
  async pullChanges(query: RateChangesQueryDto): Promise<RateChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();

    const items = await tenantPrisma.rate.findMany({
      where: {
        syncSeq: { gt: query.afterSeq },
      },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async updateRate(
    rateId: string,
    expectedVersion: number,
    data: UpdateRateDto,
  ) {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const updateData: Prisma.RateUpdateManyMutationInput = {
      version: { increment: 1 },
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.hourPriceArs !== undefined)
      updateData.hourPriceArs = data.hourPriceArs;
    if (data.stayPriceArs !== undefined)
      updateData.stayPriceArs = data.stayPriceArs;
    if (data.fractionPriceArs !== undefined)
      updateData.fractionPriceArs = data.fractionPriceArs;
    if (data.mediaEstadiaPriceArs !== undefined)
      updateData.mediaEstadiaPriceArs = data.mediaEstadiaPriceArs;
    if (data.autoFractionPrice !== undefined)
      updateData.autoFractionPrice = data.autoFractionPrice;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.shortcutNumber !== undefined)
      updateData.shortcutNumber = data.shortcutNumber;

    const result = await tenantPrisma.rate.updateMany({
      where: {
        tenantId,
        id: rateId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: updateData,
    });

    if (result.count === 0) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Rate was changed by another write. Refresh and retry with the latest version.',
        `/tenants/:tenantId/rates/${rateId}`,
        ErrorCodes.CONFLICT,
      );
    }

    return toDto(
      await tenantPrisma.rate.findUniqueOrThrow({
        where: { id: rateId },
      }),
    );
  }

  /**
   * Soft delete: stamps `deletedAt` instead of removing the row.
   *
   * The `rates_before_update` trigger bumps `sync_seq` on any UPDATE, so the
   * marked row keeps flowing through `pullChanges` as a tombstone and offline
   * clients can drop it locally. A hard delete emits nothing, which is why a
   * deleted rate used to linger forever in the desktop's IndexedDB.
   *
   * `deletedAt: null` in the where clause makes a second DELETE return 409
   * instead of re-stamping the mark and re-emitting the tombstone.
   */
  async deleteRate(rateId: string, expectedVersion: number): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await tenantPrisma.rate.updateMany({
      where: {
        tenantId,
        id: rateId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Rate was changed by another write. Refresh and retry with the latest version.',
        `/tenants/:tenantId/rates/${rateId}`,
        ErrorCodes.CONFLICT,
      );
    }
  }
}
