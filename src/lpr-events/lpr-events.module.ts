import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { LprEventsController } from './lpr-events.controller';
import { LprEventsService } from './lpr-events.service';
import { LprImageRetentionService } from './lpr-image-retention.service';

@Module({
  imports: [PrismaModule, AuditModule, StorageModule],
  controllers: [LprEventsController],
  providers: [LprEventsService, LprImageRetentionService],
  exports: [LprImageRetentionService],
})
export class LprEventsModule {}
