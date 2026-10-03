import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { DriverReservationsController } from './driver-reservations.controller';
import { DriverReservationsService } from './driver-reservations.service';
import { DriverVehiclesController } from './driver-vehicles.controller';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    DriverController,
    DriverReservationsController,
    DriverVehiclesController,
  ],
  providers: [DriverService, DriverReservationsService, DriverVehiclesService],
})
export class DriverModule {}
