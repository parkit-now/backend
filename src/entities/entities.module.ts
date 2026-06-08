import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { EntitiesController } from './entities.controller';
import { EntitiesService } from './entities.service';

@Module({
  imports: [PrismaModule, AuditModule, VehiclesModule],
  controllers: [EntitiesController],
  providers: [EntitiesService],
})
export class EntitiesModule {}
