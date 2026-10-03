import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { VehicleCategoriesController } from './vehicle-categories.controller';
import { VehicleCategoriesService } from './vehicle-categories.service';

@Module({
  imports: [PrismaModule],
  controllers: [VehicleCategoriesController],
  providers: [VehicleCategoriesService],
})
export class VehicleCategoriesModule {}
