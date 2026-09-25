import { Module } from '@nestjs/common';
import { ArcaModule } from '../arca/arca.module';
import { PrismaModule } from '../database/prisma.module';
import { EntriesController } from './entries.controller';
import { EntriesService } from './entries.service';

@Module({
  imports: [PrismaModule, ArcaModule],
  controllers: [EntriesController],
  providers: [EntriesService],
})
export class EntriesModule {}
