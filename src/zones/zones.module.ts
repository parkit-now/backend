import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  imports: [PrismaModule],
  controllers: [ZonesController],
  providers: [ZonesService],
})
export class ZonesModule {}
