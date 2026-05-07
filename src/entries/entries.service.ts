import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { prismaForTenant } from '../database/prisma-tenant';
import { CreateEntryDto } from '../generated/nestjs-dto/create-entry.dto';

@Injectable()
export class EntriesService {
  constructor(private readonly prisma: PrismaService) {}

  async createEntryForTenant(tenantId: string, data: CreateEntryDto) {
    // LOCAL -> usamos prismaForTenant para blindar el acceso al tenant actual
    const tenantPrisma = prismaForTenant(this.prisma, tenantId);

    return tenantPrisma.entry.create({
      data: {
        plate: data.plate,
        color: data.color,
        leftAt: data.leftAt,
        amountPaid: data.amountPaid,
        vehicleId: data.vehicle.connect.id,
        tenantId,
      },
    });
  }

  async findAllForTenant(tenantId: string) {
    const tenantPrisma = prismaForTenant(this.prisma, tenantId);

    return tenantPrisma.entry.findMany({
      include: {
        vehicle: true, // Prisma permite incluir la tabla global
      },
    });
  }
}
