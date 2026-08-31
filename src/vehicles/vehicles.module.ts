import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  imports: [PrismaModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  // Sin `exports`: EntitiesController era el único consumidor externo y las
  // rutas de vehículos ahora viven en VehiclesController.
})
export class VehiclesModule {}
