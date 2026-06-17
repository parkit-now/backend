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
import { LprEntryDto } from './dto/lpr-entry.dto';

type PrismaEntry = Prisma.EntryGetPayload<Record<string, never>>;

function toDto(entry: PrismaEntry): EntryDto {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    plate: entry.plate,
    color: entry.color,
    cochera: entry.cochera,
    notes: entry.notes,
    enteredAt: entry.enteredAt,
    leftAt: entry.leftAt,
    amountPaid: entry.amountPaid !== null ? Number(entry.amountPaid) : null,
    vehicleBrand: entry.vehicleBrand,
    vehicleModel: entry.vehicleModel,
    rateId: entry.rateId,
    rateSnapshotName: entry.rateSnapshotName,
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
    cashSessionId: entry.cashSessionId,
    ticketNumber: entry.ticketNumber,
    source: entry.source,
    vehicleType: entry.vehicleType,
    entryImageUrl: entry.entryImageUrl,
    entryCameraId: entry.entryCameraId,
    exitImageUrl: entry.exitImageUrl,
    exitCameraId: entry.exitCameraId,
    whitelistId: entry.whitelistId,
    version: entry.version,
    syncSeq: entry.syncSeq,
    updatedAt: entry.updatedAt,
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
        cochera: data.cochera,
        notes: data.notes,
        enteredAt: new Date(data.enteredAt),
        vehicleBrand: data.vehicleBrand,
        vehicleModel: data.vehicleModel,
        rateId: data.rateId,
        rateSnapshotName: data.rateSnapshotName,
        rateSnapshotHourPriceArs: data.rateSnapshotHourPriceArs,
        rateSnapshotStayPriceArs: data.rateSnapshotStayPriceArs,
        rateSnapshotFractionPriceArs: data.rateSnapshotFractionPriceArs,
        cashSessionId: data.cashSessionId,
        ticketNumber: data.ticketNumber,
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
      where: { syncSeq: { gt: query.afterSeq } },
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
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const leftAt = data.leftAt ? new Date(data.leftAt) : new Date();

    // Compute amountPaid: sum of payments[] if provided, otherwise use the
    // directly provided amountPaid (legacy / offline fallback).
    const computedAmount =
      data.payments && data.payments.length > 0
        ? data.payments.reduce((sum, p) => sum + p.amount, 0)
        : data.amountPaid;

    const entry = await this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.EntryUpdateInput = {
        version: { increment: 1 },
        leftAt,
        amountPaid: computedAmount,
      };
      if (data.cochera !== undefined) updateData.cochera = data.cochera;
      if (data.notes !== undefined) updateData.notes = data.notes;

      const result = await tx.entry.updateMany({
        where: {
          tenantId,
          id: entryId,
          version: expectedVersion,
          leftAt: null,
        },
        data: updateData,
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

      // Create payment transaction records if payments were provided.
      if (data.payments && data.payments.length > 0) {
        const cashSessionId =
          data.cashSessionId ??
          (
            await tx.cashSession.findFirst({
              where: { tenantId, closedAt: null },
              select: { id: true },
            })
          )?.id ??
          null;

        await tx.paymentTransaction.createMany({
          data: data.payments.map((p) => ({
            id: p.id,
            tenantId,
            entryId,
            cashSessionId,
            paymentMethodId: p.paymentMethodId ?? null,
            paymentMethodName: p.paymentMethodName,
            amount: p.amount,
          })),
        });
      }

      return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
    });

    return toDto(entry);
  }

  async createStayFromLprEvent(data: LprEntryDto): Promise<EntryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const plate = data.plate.toUpperCase();
    const now = new Date();

    const entry = await this.prisma.$transaction(async (tx) => {
      // 1. Reject if an active stay for this plate already exists.
      const existing = await tx.entry.findFirst({
        where: { tenantId, plate, leftAt: null },
      });
      if (existing) {
        throw new FormattedException(
          'Duplicate active stay',
          HttpStatus.CONFLICT,
          `Plate ${plate} already has an active stay.`,
          `/tenants/${tenantId}/entries/lpr`,
          ErrorCodes.ENTRY_DUPLICATE_ACTIVE_STAY,
        );
      }

      // 2. Check whitelist — null result means no active authorization.
      const whitelistEntry = await tx.whitelist.findFirst({
        where: {
          tenantId,
          plate,
          OR: [{ validFrom: null }, { validFrom: { lte: now } }],
          AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
        },
      });

      // 3. Persist the stay. UUID is server-generated for LPR entries.
      return tx.entry.create({
        data: {
          id: crypto.randomUUID(),
          tenantId,
          plate,
          source: 'auto',
          vehicleType: data.vehicleType ?? null,
          entryImageUrl: data.imageUrl ?? null,
          entryCameraId: data.cameraId ?? null,
          enteredAt: data.timestamp ? new Date(data.timestamp) : now,
          whitelistId: whitelistEntry?.id ?? null,
        },
      });
    });

    return toDto(entry);
  }
}
