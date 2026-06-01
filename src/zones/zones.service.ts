import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(dto: CreateZoneDto) {
    const client = this.prisma.getTenantClient();
    return client.zone.create({
      data: {
        name: dto.name,
        carSpots: dto.carSpots ?? 0,
        motorcycleSpots: dto.motorcycleSpots ?? 0,
        bicycleSpots: dto.bicycleSpots ?? 0,
        // tenantId is injected automatically by the prismaForTenant extension.
      } as never,
    });
  }

  async findAll() {
    return this.prisma.getTenantClient().zone.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, dto: UpdateZoneDto) {
    await this.ensureExists(id);
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    return this.prisma.getTenantClient().zone.update({
      where: { id, tenantId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.carSpots !== undefined ? { carSpots: dto.carSpots } : {}),
        ...(dto.motorcycleSpots !== undefined
          ? { motorcycleSpots: dto.motorcycleSpots }
          : {}),
        ...(dto.bicycleSpots !== undefined
          ? { bicycleSpots: dto.bicycleSpots }
          : {}),
      },
    });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    await this.prisma.getTenantClient().zone.delete({
      where: { id, tenantId },
    });
    return { id };
  }

  /**
   * Ensures the zone exists WITHIN the active tenant (findFirst applies the
   * tenantId filter via the extension). Throws ZONE_NOT_FOUND otherwise.
   */
  private async ensureExists(id: string) {
    const zone = await this.prisma.getTenantClient().zone.findFirst({
      where: { id },
    });
    if (!zone) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Zone ${id} not found`,
        '/tenants/:tenantId/zones',
        ErrorCodes.ZONE_NOT_FOUND,
      );
    }
    return zone;
  }
}
