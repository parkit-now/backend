import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

@Module({
  imports: [PrismaModule],
  controllers: [RatesController],
  providers: [RatesService],
})
export class RatesModule {}
