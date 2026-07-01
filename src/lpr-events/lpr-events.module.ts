import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { LprEventsController } from './lpr-events.controller';
import { LprEventsService } from './lpr-events.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [LprEventsController],
  providers: [LprEventsService],
})
export class LprEventsModule {}
