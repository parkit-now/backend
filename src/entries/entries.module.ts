import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';

@Module({
  imports: [PrismaModule],
  controllers: [EntriesController],
  providers: [EntriesService],
})
export class EntriesModule {}
