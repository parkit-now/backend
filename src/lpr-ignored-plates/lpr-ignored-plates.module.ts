import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { LprIgnoredPlatesController } from './lpr-ignored-plates.controller';
import { LprIgnoredPlatesService } from './lpr-ignored-plates.service';

@Module({
  imports: [PrismaModule],
  controllers: [LprIgnoredPlatesController],
  providers: [LprIgnoredPlatesService],
})
export class LprIgnoredPlatesModule {}
