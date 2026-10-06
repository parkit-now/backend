import { Module } from '@nestjs/common';
import { ArcaModule } from '../../arca/arca.module';
import { AuditModule } from '../../audit/audit.module';
import { PrismaModule } from '../../database/prisma.module';
import { MercadoPagoModule } from '../../mercado-pago/mercado-pago.module';
import { ReservationsModule } from '../../reservations/reservations.module';
import { StorageModule } from '../../storage/storage.module';
import { ParkingDeletionService } from './parking-deletion.service';
import { ParkingsController } from './parkings.controller';
import { ParkingsService } from './parkings.service';
import { TenantPurgeService } from './tenant-purge.service';

@Module({
  // Mercado Pago, ARCA y reservas entran por `ParkingDeletionService`: dar de
  // baja un estacionamiento tiene que cancelar las reservas vivas y
  // desvincular las integraciones, en ese orden.
  imports: [
    PrismaModule,
    AuditModule,
    MercadoPagoModule,
    ArcaModule,
    ReservationsModule,
    StorageModule,
  ],
  controllers: [ParkingsController],
  providers: [ParkingsService, ParkingDeletionService, TenantPurgeService],
})
export class ParkingsModule {}
