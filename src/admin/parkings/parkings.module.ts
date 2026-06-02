import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { PrismaModule } from '../../database/prisma.module';
import { ParkingsController } from './parkings.controller';
import { ParkingsService } from './parkings.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ParkingsController],
  providers: [ParkingsService],
})
export class ParkingsModule {}
