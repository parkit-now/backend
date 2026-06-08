import { Injectable } from '@nestjs/common';
import { Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
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
}
