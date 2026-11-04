import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type PlateProfile } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import {
  CreatePlateProfileDto,
  DeletePlateProfileDto,
  PlateProfileChangesQueryDto,
  PlateProfileDto,
  UpdatePlateProfileDto,
} from './dto/plate-profile.dto';

export function plateProfileDto(row: PlateProfile): PlateProfileDto {
  return {
    ...row,
    lastEnteredAt: row.lastEnteredAt?.toISOString() ?? null,
    learnAfter: row.learnAfter?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
@Injectable()
export class PlateProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}

  async list() {
    return (
      await this.prisma.getTenantClient().plateProfile.findMany({
        where: { deletedAt: null },
        orderBy: { plate: 'asc' },
      })
    ).map(plateProfileDto);
  }
  async changes(query: PlateProfileChangesQueryDto) {
    const rows = await this.prisma.getTenantClient().plateProfile.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });
    return {
      items: rows.map(plateProfileDto),
      maxSeq: rows.at(-1)?.syncSeq ?? query.afterSeq,
    };
  }
  async get(plate: string) {
    const row = await this.prisma
      .getTenantClient()
      .plateProfile.findFirst({ where: { plate } });
    if (!row)
      throw new FormattedException(
        'Not found',
        HttpStatus.NOT_FOUND,
        'Plate profile not found.',
        '/plate-profiles',
        ErrorCodes.NOT_FOUND,
      );
    return plateProfileDto(row);
  }
  private conflict(): never {
    throw new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'Plate profile changed. Reload before retrying.',
      '/plate-profiles',
      ErrorCodes.CONFLICT,
    );
  }
  async mutate(
    plate: string,
    input:
      | CreatePlateProfileDto
      | UpdatePlateProfileDto
      | DeletePlateProfileDto,
    operation: 'create' | 'update' | 'delete',
  ) {
    const tenantId = this.context.getTenantIdOrThrow();
    if (!/^[A-Z0-9]{1,20}$/.test(plate))
      throw new FormattedException(
        'Invalid plate',
        HttpStatus.BAD_REQUEST,
        'Invalid plate.',
        '/plate-profiles',
        ErrorCodes.VALIDATION_FAILED,
      );
    try {
      return await this.prisma.getTenantClient().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + plate}, 0))`;
        const current = await tx.plateProfile.findFirst({
          where: { tenantId, plate },
        });
        const receipt = await tx.plateProfileMutation.findFirst({
          where: { tenantId, id: input.mutationId },
        });
        if (receipt) {
          if (receipt.plate !== plate || !current) this.conflict();
          return plateProfileDto(current);
        }
        if ((current?.editVersion ?? 0) !== input.expectedVersion)
          this.conflict();
        if (operation === 'update' && (!current || current.deletedAt))
          this.conflict();
        if (operation === 'delete' && current?.deletedAt) this.conflict();
        if (
          operation === 'create' &&
          current &&
          !current.deletedAt &&
          current.editVersion > 0
        )
          this.conflict();
        const data: Prisma.PlateProfileUncheckedUpdateInput = {
          editVersion: { increment: 1 },
          learnAfter: new Date(input.occurredAt),
          deletedAt: operation === 'delete' ? new Date() : null,
        };
        if (operation !== 'delete') {
          const fields = input as UpdatePlateProfileDto;
          for (const field of [
            'vehicleBrand',
            'vehicleModel',
            'color',
          ] as const)
            if (fields[field] !== undefined)
              data[field] = fields[field]?.trim() || null;
          for (const [field, label, table] of [
            ['vehicleTypeId', 'vehicleTypeName', 'vehicleType'],
            ['rateId', 'rateName', 'rate'],
          ] as const) {
            if (
              fields[field] === undefined ||
              (fields[field] !== null && fields[field] === current?.[field])
            )
              continue;
            const id = fields[field];
            const where = { tenantId, id: id ?? '', deletedAt: null };
            const option = !id
              ? null
              : table === 'rate'
                ? await tx.rate.findFirst({ where, select: { name: true } })
                : await tx.vehicleType.findFirst({
                    where,
                    select: { name: true },
                  });
            if (id && !option)
              throw new FormattedException(
                'Invalid option',
                HttpStatus.BAD_REQUEST,
                'Option not available in this parking.',
                '/plate-profiles',
                ErrorCodes.VALIDATION_FAILED,
              );
            data[field] = id ?? null;
            data[label] = option?.name ?? null;
          }
        }
        const row = current
          ? await tx.plateProfile.update({
              where: { tenantId_plate: { tenantId, plate }, tenantId },
              data,
            })
          : await tx.plateProfile.create({
              data: {
                tenantId,
                plate,
                editVersion: 1,
                learnAfter: new Date(input.occurredAt),
                deletedAt: operation === 'delete' ? new Date() : null,
                vehicleBrand: (data.vehicleBrand as string | null) ?? null,
                vehicleModel: (data.vehicleModel as string | null) ?? null,
                color: (data.color as string | null) ?? null,
                vehicleTypeId: (data.vehicleTypeId as string | null) ?? null,
                vehicleTypeName:
                  (data.vehicleTypeName as string | null) ?? null,
                rateId: (data.rateId as string | null) ?? null,
                rateName: (data.rateName as string | null) ?? null,
              },
            });
        await tx.plateProfileMutation.create({
          data: { id: input.mutationId, tenantId, plate },
        });
        return plateProfileDto(row);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        this.conflict();
      throw error;
    }
  }
}
