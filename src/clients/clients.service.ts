import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Client, type ClientPlate } from '@prisma/client';
import { isValidCuit, normalizeCuit } from '../arca/arca-cuit';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  ClientChangesQueryDto,
  type ClientDto,
  type CreateClientDto,
  normalizeClientPlate,
  type UpdateClientDto,
} from './dto/client.dto';

type ClientWithPlates = Client & { plates: ClientPlate[] };
type Transaction = Pick<
  ReturnType<PrismaService['getTenantClient']>,
  'client' | 'clientPlate'
>;

function toDto(row: ClientWithPlates): ClientDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    plates: row.plates
      .filter((plate) => !plate.deletedAt)
      .map((plate) => plate.plate)
      .sort(),
    cuit: row.cuit,
    name: row.name,
    email: row.email,
    phone: row.phone,
    version: row.version,
    syncSeq: row.syncSeq,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}

  private tenantId() {
    return this.context.getTenantIdOrThrow();
  }

  private error(status: HttpStatus, detail: string): never {
    throw new FormattedException(
      status === HttpStatus.CONFLICT
        ? 'Conflict'
        : status === HttpStatus.NOT_FOUND
          ? 'Not found'
          : 'Invalid client',
      status,
      detail,
      '/clients',
      status === HttpStatus.CONFLICT
        ? ErrorCodes.CONFLICT
        : status === HttpStatus.NOT_FOUND
          ? ErrorCodes.NOT_FOUND
          : ErrorCodes.VALIDATION_FAILED,
    );
  }

  private cleanCuit(cuit: string | null | undefined): string | null {
    const normalized = cuit?.trim() ? normalizeCuit(cuit) : null;
    if (cuit?.trim() && (!normalized || !isValidCuit(normalized))) {
      this.error(HttpStatus.BAD_REQUEST, 'Invalid CUIT.');
    }
    return normalized || null;
  }

  private cleanPlates(plates: string[]): string[] {
    const normalized = plates.map(normalizeClientPlate);
    if (
      normalized.length === 0 ||
      normalized.some((plate) => !/^[A-Z0-9]{1,20}$/.test(plate)) ||
      new Set(normalized).size !== normalized.length
    ) {
      this.error(HttpStatus.BAD_REQUEST, 'Invalid or duplicate plate.');
    }
    return normalized;
  }

  async list(): Promise<ClientDto[]> {
    const rows = await this.prisma.getTenantClient().client.findMany({
      where: { deletedAt: null },
      include: { plates: { where: { deletedAt: null } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async changes(query: ClientChangesQueryDto) {
    const rows = await this.prisma.getTenantClient().client.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      include: { plates: { where: { deletedAt: null } } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });
    return {
      items: rows.map(toDto),
      maxSeq: rows.at(-1)?.syncSeq ?? query.afterSeq,
    };
  }

  private async assignPlates(
    tx: Transaction,
    tenantId: string,
    clientId: string,
    plates: string[],
    move: boolean,
  ) {
    const existing = await tx.clientPlate.findMany({
      where: { tenantId, plate: { in: plates }, deletedAt: null },
    });
    const taken = existing.filter((row) => row.clientId !== clientId);
    if (taken.length && !move) {
      this.error(
        HttpStatus.CONFLICT,
        `Plate already belongs to another client: ${taken.map((row) => row.plate).join(', ')}.`,
      );
    }
    for (const row of taken) {
      await tx.clientPlate.updateMany({
        where: { id: row.id, tenantId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const remaining = await tx.clientPlate.count({
        where: { tenantId, clientId: row.clientId, deletedAt: null },
      });
      if (!remaining)
        await tx.client.updateMany({
          where: { id: row.clientId, tenantId, deletedAt: null },
          data: { deletedAt: new Date(), version: { increment: 1 } },
        });
    }
    const own = await tx.clientPlate.findMany({
      where: { tenantId, clientId, deletedAt: null },
    });
    for (const row of own) {
      if (!plates.includes(row.plate))
        await tx.clientPlate.updateMany({
          where: { id: row.id, tenantId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
    }
    const assigned = new Set(own.map((row) => row.plate));
    for (const plate of plates) {
      if (!assigned.has(plate))
        await tx.clientPlate.create({ data: { tenantId, clientId, plate } });
    }
  }

  private async fresh(tx: Transaction, tenantId: string, id: string) {
    return toDto(
      await tx.client.findFirstOrThrow({
        where: { tenantId, id },
        include: { plates: { where: { deletedAt: null } } },
      }),
    );
  }

  private handleUnique(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      this.error(
        HttpStatus.CONFLICT,
        'A client with this CUIT or plate already exists.',
      );
    }
    throw error;
  }

  async create(input: CreateClientDto): Promise<ClientDto> {
    const tenantId = this.tenantId();
    const plates = this.cleanPlates(input.plates);
    const cuit = this.cleanCuit(input.cuit);
    try {
      return await this.prisma.getTenantClient().$transaction(async (tx) => {
        const previous = await tx.client.findFirst({
          where: { id: input.id, tenantId },
          include: { plates: { where: { deletedAt: null } } },
        });
        if (previous) return toDto(previous); // Offline retry after a committed create.
        await tx.client.create({
          data: {
            id: input.id,
            tenantId,
            cuit,
            name: input.name?.trim() || null,
            nameEdited: Boolean(input.name?.trim()) && !input.nameIsAutomatic,
            email: input.email?.trim() || null,
            phone: input.phone?.trim() || null,
          },
        });
        await this.assignPlates(
          tx,
          tenantId,
          input.id,
          plates,
          input.movePlates === true,
        );
        return this.fresh(tx, tenantId, input.id);
      });
    } catch (error) {
      return this.handleUnique(error);
    }
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateClientDto,
  ): Promise<ClientDto> {
    const tenantId = this.tenantId();
    const plates =
      input.plates === undefined ? undefined : this.cleanPlates(input.plates);
    const cuit =
      input.cuit === undefined ? undefined : this.cleanCuit(input.cuit);
    try {
      return await this.prisma.getTenantClient().$transaction(async (tx) => {
        const current = await tx.client.findFirst({
          where: { id, tenantId, deletedAt: null },
        });
        if (!current) this.error(HttpStatus.NOT_FOUND, 'Client not found.');
        const name =
          input.name === undefined ? undefined : input.name?.trim() || null;
        const result = await tx.client.updateMany({
          where: { id, tenantId, version: expectedVersion, deletedAt: null },
          data: {
            version: { increment: 1 },
            ...(cuit !== undefined && { cuit }),
            ...(name !== undefined && {
              name,
              nameEdited:
                current.nameEdited ||
                (name !== current.name && !input.nameIsAutomatic),
            }),
            ...(input.email !== undefined && {
              email: input.email?.trim() || null,
            }),
            ...(input.phone !== undefined && {
              phone: input.phone?.trim() || null,
            }),
          },
        });
        if (!result.count)
          this.error(HttpStatus.CONFLICT, 'Client version changed.');
        if (plates)
          await this.assignPlates(
            tx,
            tenantId,
            id,
            plates,
            input.movePlates === true,
          );
        return this.fresh(tx, tenantId, id);
      });
    } catch (error) {
      return this.handleUnique(error);
    }
  }

  async remove(id: string, expectedVersion: number): Promise<ClientDto> {
    const tenantId = this.tenantId();
    return this.prisma.getTenantClient().$transaction(async (tx) => {
      const current = await tx.client.findFirst({ where: { id, tenantId } });
      if (!current) this.error(HttpStatus.NOT_FOUND, 'Client not found.');
      if (current.deletedAt) return this.fresh(tx, tenantId, id);
      const result = await tx.client.updateMany({
        where: { id, tenantId, version: expectedVersion, deletedAt: null },
        data: { version: { increment: 1 }, deletedAt: new Date() },
      });
      if (!result.count)
        this.error(HttpStatus.CONFLICT, 'Client version changed.');
      await tx.clientPlate.updateMany({
        where: { tenantId, clientId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return this.fresh(tx, tenantId, id);
    });
  }
}
