import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateEntryDto } from '../generated/nestjs-dto/create-entry.dto';

@Injectable()
export class EntriesService {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(data: CreateEntryDto) {
    // Usamos getTenantClient() para obtener el cliente ya blindado
    const tenantPrisma = this.prisma.getTenantClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return await (tenantPrisma as any).entry.create({
      data: {
        plate: data.plate,
        color: data.color,
        leftAt: data.leftAt,
        amountPaid: data.amountPaid,
        vehicleId: data.vehicle.connect.id,
        // No necesitamos pasar tenantId manualmente, prismaForTenant lo valida
      },
    });
  }

  async findAll() {
    const tenantPrisma = this.prisma.getTenantClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return await (tenantPrisma as any).entry.findMany({
      include: {
        vehicle: true,
      },
    });
  }
}
