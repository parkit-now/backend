import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { VehicleTypesController } from './vehicle-types.controller';
import { VehicleTypesService } from './vehicle-types.service';

@Module({
  imports: [PrismaModule],
  controllers: [VehicleTypesController],
  providers: [VehicleTypesService],
  // Sin `exports`: nadie lo consume desde otro módulo.
})
export class VehicleTypesModule {}
