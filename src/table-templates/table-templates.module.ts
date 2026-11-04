import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../database/prisma.module';
import {
  TableTemplatesController,
  AdminTableTemplatesController,
} from './table-templates.controller';
import { TableTemplatesService } from './table-templates.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [TableTemplatesController, AdminTableTemplatesController],
  providers: [TableTemplatesService],
})
export class TableTemplatesModule {}
