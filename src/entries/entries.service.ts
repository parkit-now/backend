import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateEntryDto } from '../generated/nestjs-dto/create-entry.dto';

@Injectable()
export class EntriesService {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(data: CreateEntryDto) {
    // Usamos getTenantClient() para obtener el cliente ya blindado
    const tenantPrisma = this.prisma.getTenantClient();

    return await tenantPrisma.entry.create({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: {
        plate: data.plate,
        color: data.color,
        leftAt: data.leftAt,
        amountPaid: data.amountPaid,
        vehicleId: data.vehicle.connect.id,
        // El tenantId se inyecta automáticamente en la extensión de Prisma
      } as any,
    });
  }

  async findAll() {
    const tenantPrisma = this.prisma.getTenantClient();
    return await tenantPrisma.entry.findMany({
      include: {
        vehicle: true,
      },
    });
  }
}
