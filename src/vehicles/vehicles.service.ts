import { HttpStatus, Injectable } from '@nestjs/common';
import { Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VehicleCatalogChangesQueryDto,
  VehicleCatalogChangesResponseDto,
  VehicleCatalogItemDto,
} from './dto/vehicle-catalog.dto';

function toDto(v: Vehicle): VehicleCatalogItemDto {
  return {
    id: v.id,
    brand: v.brand,
    model: v.model,
    type: v.type ?? null,
    tenantId: v.tenantId ?? null,
    deletedAt: v.deletedAt ? v.deletedAt.toISOString() : null,
    syncSeq: v.syncSeq,
    updatedAt: v.updatedAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateVehicleDto, tenantId?: string) {
    return this.prisma.vehicle.create({
      data: {
        id: data.id,
        brand: data.brand,
        model: data.model,
        type: data.type,
        tenantId: tenantId ?? null,
      },
    });
  }

  async findAll() {
    return this.prisma.vehicle.findMany();
  }

  /** Returns global (tenantId IS NULL) + tenant-specific vehicles, syncSeq > afterSeq. */
  async pullCatalogChanges(
    tenantId: string,
    query: VehicleCatalogChangesQueryDto,
  ): Promise<VehicleCatalogChangesResponseDto> {
    const items = await this.prisma.vehicle.findMany({
      where: {
        OR: [{ tenantId: null }, { tenantId }],
        syncSeq: { gt: query.afterSeq },
      },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async createTenantVehicle(
    tenantId: string,
    data: CreateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    const v = await this.create(data, tenantId);
    return toDto(v);
  }

  async updateTenantVehicle(
    id: string,
    tenantId: string,
    data: UpdateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing || existing.tenantId !== tenantId) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Vehicle ${id} not found or does not belong to this entity`,
        `/tenants/${tenantId}/vehicles/${id}`,
        ErrorCodes.VEHICLE_NOT_FOUND,
      );
    }
    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(data.brand !== undefined && { brand: data.brand }),
        ...(data.model !== undefined && { model: data.model }),
        ...(data.type !== undefined && { type: data.type }),
        version: { increment: 1 },
      },
    });
    return toDto(updated);
  }

  async deleteTenantVehicle(id: string, tenantId: string): Promise<void> {
    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing || existing.tenantId !== tenantId) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Vehicle ${id} not found or does not belong to this entity`,
        `/tenants/${tenantId}/vehicles/${id}`,
        ErrorCodes.VEHICLE_NOT_FOUND,
      );
    }
    await this.prisma.vehicle.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
