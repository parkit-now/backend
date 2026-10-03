import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { DriverReservationsController } from './driver-reservations.controller';
import { DriverReservationsService } from './driver-reservations.service';
import { DriverVehicleCatalogController } from './driver-vehicle-catalog.controller';
import { DriverVehiclesController } from './driver-vehicles.controller';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  imports: [PrismaModule, ReservationsModule],
  controllers: [
    DriverController,
    DriverReservationsController,
    DriverVehiclesController,
    DriverVehicleCatalogController,
  ],
  providers: [DriverService, DriverReservationsService, DriverVehiclesService],
})
export class DriverModule {}
