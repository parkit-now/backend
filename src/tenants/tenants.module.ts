import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [PrismaModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
