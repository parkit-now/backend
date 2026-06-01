import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CompanyOwnerGuard } from '../auth/guards/company-owner.guard';
import { PrismaModule } from '../database/prisma.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [CompaniesController],
  providers: [CompaniesService, CompanyOwnerGuard],
})
export class CompaniesModule {}
