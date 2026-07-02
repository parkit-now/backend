import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { LprEventsController } from './lpr-events.controller';
import { LprEventsService } from './lpr-events.service';

@Module({
  imports: [PrismaModule, AuditModule, StorageModule],
  controllers: [LprEventsController],
  providers: [LprEventsService],
})
export class LprEventsModule {}
