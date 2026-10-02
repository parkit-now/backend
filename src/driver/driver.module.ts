import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  imports: [PrismaModule],
  controllers: [DriverController],
  providers: [DriverService],
})
export class DriverModule {}
