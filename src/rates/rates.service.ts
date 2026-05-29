import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { CreateRateDto } from './dto/create-rate.dto';
import { ListRatesQueryDto } from './dto/list-rates-query.dto';
import { RateChangesQueryDto } from './dto/rate-changes-query.dto';
import { UpdateRateDto } from './dto/update-rate.dto';

type RateChangesResponse = {
  items: Prisma.RateGetPayload<Record<string, never>>[];
  maxSeq: number;
};

@Injectable()
export class RatesService {
  constructor(private readonly prisma: PrismaService) {}

  async createRate(data: CreateRateDto) {
    const tenantPrisma = this.prisma.getTenantClient();
    return tenantPrisma.rate.create({
      data: {
        id: data.id,
        name: data.name,
        hourPriceArs: data.hourPriceArs,
        stayPriceArs: data.stayPriceArs,
        fractionPriceArs: data.fractionPriceArs,
      },
    });
  }

  async listRates(query: ListRatesQueryDto) {
    const tenantPrisma = this.prisma.getTenantClient();
    const where: Prisma.RateWhereInput = {};

    if (!query.includeInactive) {
      where.isActive = true;
    }
    if (!query.includeDeleted) {
      where.deletedAt = null;
    }

    return tenantPrisma.rate.findMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
  }

  async pullChanges(query: RateChangesQueryDto): Promise<RateChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();
    const includeDeleted = query.includeDeleted ?? true;

    const items = await tenantPrisma.rate.findMany({
      where: {
        syncSeq: { gt: query.afterSeq },
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });

    const maxSeq = items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items, maxSeq };
  }

  async updateRate(
    rateId: string,
    expectedVersion: number,
    data: UpdateRateDto,
  ) {
    const tenantPrisma = this.prisma.getTenantClient();

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
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const result = await tenantPrisma.rate.updateMany({
      where: {
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

    return tenantPrisma.rate.findUniqueOrThrow({
      where: { id: rateId },
    });
  }

  async deactivateRate(rateId: string, expectedVersion: number) {
    const tenantPrisma = this.prisma.getTenantClient();

    const result = await tenantPrisma.rate.updateMany({
      where: {
        id: rateId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: {
        isActive: false,
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

    return tenantPrisma.rate.findUniqueOrThrow({
      where: { id: rateId },
    });
  }
}
