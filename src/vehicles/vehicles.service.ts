import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateVehicleDto } from '../generated/nestjs-dto/create-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateVehicleDto) {
    // GLOBAL -> usamos this.prisma de manera directa
    return this.prisma.vehicle.create({
      data: {
        brand: data.brand,
        model: data.model,
        type: data.type,
      },
    });
  }

  async findAll() {
    return this.prisma.vehicle.findMany();
  }
}
