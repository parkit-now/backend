import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CloseEntryDto } from './dto/close-entry.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { EntryChangesQueryDto } from './dto/entry-changes-query.dto';
import { EntryDto } from './dto/entry.dto';

type PrismaEntry = Prisma.EntryGetPayload<Record<string, never>>;

function toDto(entry: PrismaEntry): EntryDto {
  return {
    ...entry,
    amountPaid: entry.amountPaid !== null ? Number(entry.amountPaid) : null,
    rateSnapshotHourPriceArs:
      entry.rateSnapshotHourPriceArs !== null
        ? Number(entry.rateSnapshotHourPriceArs)
        : null,
    rateSnapshotStayPriceArs:
      entry.rateSnapshotStayPriceArs !== null
        ? Number(entry.rateSnapshotStayPriceArs)
        : null,
    rateSnapshotFractionPriceArs:
      entry.rateSnapshotFractionPriceArs !== null
        ? Number(entry.rateSnapshotFractionPriceArs)
        : null,
  };
}

type EntryChangesResponse = {
  items: EntryDto[];
  maxSeq: number;
};

@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createEntry(data: CreateEntryDto): Promise<EntryDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const entry = await tenantPrisma.entry.create({
      data: {
        id: data.id,
        plate: data.plate.toUpperCase(),
        color: data.color,
        enteredAt: new Date(data.enteredAt),
        vehicleId: data.vehicleId,
        rateId: data.rateId,
        rateSnapshotName: data.rateSnapshotName,
        rateSnapshotHourPriceArs: data.rateSnapshotHourPriceArs,
        rateSnapshotStayPriceArs: data.rateSnapshotStayPriceArs,
        rateSnapshotFractionPriceArs: data.rateSnapshotFractionPriceArs,
        // tenantId is injected by prismaForTenant(...)
      } as Prisma.EntryUncheckedCreateInput,
    });
    return toDto(entry);
  }

  async findAll(): Promise<EntryDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const entries = await tenantPrisma.entry.findMany({
      orderBy: [{ enteredAt: 'desc' }],
    });
    return entries.map(toDto);
  }

  async pullChanges(
    query: EntryChangesQueryDto,
  ): Promise<EntryChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();

    const items = await tenantPrisma.entry.findMany({
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

  async closeEntry(
    entryId: string,
    expectedVersion: number,
    data: CloseEntryDto,
  ): Promise<EntryDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await tenantPrisma.entry.updateMany({
      where: {
        tenantId,
        id: entryId,
        version: expectedVersion,
        leftAt: null,
      },
      data: {
        version: { increment: 1 },
        leftAt: data.leftAt ? new Date(data.leftAt) : new Date(),
        amountPaid: data.amountPaid,
      },
    });

    if (result.count === 0) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Entry was already closed or changed by another write. Refresh and retry.',
        `/tenants/:tenantId/entries/${entryId}`,
        ErrorCodes.CONFLICT,
      );
    }

    return toDto(
      await tenantPrisma.entry.findUniqueOrThrow({ where: { id: entryId } }),
    );
  }
}
