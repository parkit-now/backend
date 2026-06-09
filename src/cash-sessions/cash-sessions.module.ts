import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { CashSessionsController } from './cash-sessions.controller';
import { CashSessionsService } from './cash-sessions.service';

@Module({
  imports: [PrismaModule],
  controllers: [CashSessionsController],
  providers: [CashSessionsService],
})
export class CashSessionsModule {}
