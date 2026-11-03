import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { PlateProfilesController } from './plate-profiles.controller';
import { PlateProfilesService } from './plate-profiles.service';
@Module({
  imports: [PrismaModule],
  controllers: [PlateProfilesController],
  providers: [PlateProfilesService],
})
export class PlateProfilesModule {}
