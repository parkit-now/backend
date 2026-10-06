import { HttpStatus, Injectable } from '@nestjs/common';
import { LprIgnoredPlate, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  CreateLprIgnoredPlateDto,
  LprIgnoredPlateChangesQueryDto,
  LprIgnoredPlateDto,
  UpdateLprIgnoredPlateDto,
  normalizeIgnoredPlate,
} from './dto/lpr-ignored-plate.dto';

function toDto(row: LprIgnoredPlate): LprIgnoredPlateDto {
  return {
    ...row,
    validFrom: row.validFrom?.toISOString().slice(0, 10) ?? null,
    validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class LprIgnoredPlatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}

  async list() {
    return (
      await this.prisma.getTenantClient().lprIgnoredPlate.findMany({
        where: { deletedAt: null },
        orderBy: { plate: 'asc' },
      })
    ).map(toDto);
  }

  async changes(query: LprIgnoredPlateChangesQueryDto) {
    const items = await this.prisma.getTenantClient().lprIgnoredPlate.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });
    return {
      items: items.map(toDto),
      maxSeq: items.at(-1)?.syncSeq ?? query.afterSeq,
    };
  }

  private validateRange(from?: string | null, until?: string | null) {
    if (from && until && from > until) {
      throw new FormattedException(
        'Invalid validity range',
        HttpStatus.BAD_REQUEST,
        'validFrom must not be after validUntil.',
        '/lpr-ignored-plates',
        ErrorCodes.VALIDATION_FAILED,
      );
    }
  }

  async create(input: CreateLprIgnoredPlateDto) {
    this.validateRange(input.validFrom, input.validUntil);
    const db = this.prisma.getTenantClient();
    const plate = normalizeIgnoredPlate(input.plate);
    const data = {
      id: input.id,
      plate,
      notes: input.notes?.trim() || null,
      active: input.active ?? true,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      tenantId: this.context.getTenantIdOrThrow(),
    };
    // Retrying a committed offline create must not create a duplicate or hide a later edit.
    const existing = await db.lprIgnoredPlate.findFirst({
      where: { id: input.id },
    });
    if (existing) return toDto(existing);
    return toDto(await db.lprIgnoredPlate.create({ data }));
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateLprIgnoredPlateDto,
  ) {
    const db = this.prisma.getTenantClient();
    const tenantId = this.context.getTenantIdOrThrow();
    const existing = await db.lprIgnoredPlate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) this.notFound();
    this.validateRange(
      input.validFrom === undefined
        ? existing.validFrom?.toISOString().slice(0, 10)
        : input.validFrom,
      input.validUntil === undefined
        ? existing.validUntil?.toISOString().slice(0, 10)
        : input.validUntil,
    );
    const data: Prisma.LprIgnoredPlateUpdateManyMutationInput = {
      version: { increment: 1 },
    };
    if (input.plate !== undefined)
      data.plate = normalizeIgnoredPlate(input.plate);
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
    if (input.active !== undefined) data.active = input.active;
    if (input.validFrom !== undefined)
      data.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.validUntil !== undefined)
      data.validUntil = input.validUntil ? new Date(input.validUntil) : null;
    const result = await db.lprIgnoredPlate.updateMany({
      where: { id, tenantId, deletedAt: null, version: expectedVersion },
      data,
    });
    if (!result.count) this.conflict();
    return toDto(await db.lprIgnoredPlate.findFirstOrThrow({ where: { id } }));
  }

  async remove(id: string, expectedVersion: number) {
    const db = this.prisma.getTenantClient();
    const tenantId = this.context.getTenantIdOrThrow();
    const existing = await db.lprIgnoredPlate.findFirst({ where: { id } });
    if (!existing) this.notFound();
    if (existing.deletedAt) return toDto(existing);
    const result = await db.lprIgnoredPlate.updateMany({
      where: { id, tenantId, version: expectedVersion, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (!result.count) this.conflict();
    return toDto(await db.lprIgnoredPlate.findFirstOrThrow({ where: { id } }));
  }

  private notFound(): never {
    throw new FormattedException(
      'Not found',
      HttpStatus.NOT_FOUND,
      'Ignored plate not found.',
      '/lpr-ignored-plates',
      ErrorCodes.NOT_FOUND,
    );
  }
  private conflict(): never {
    throw new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'Ignored plate version changed.',
      '/lpr-ignored-plates',
      ErrorCodes.CONFLICT,
    );
  }
}
