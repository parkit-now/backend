import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../database/prisma.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { TenantStaffController } from './tenant-staff.controller';
import { TenantStaffService } from './tenant-staff.service';

// `PermissionsService` no se declara acá: lo provee `AuthModule`, que es
// `@Global()`.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [StaffController, TenantStaffController],
  providers: [StaffService, TenantStaffService],
})
export class StaffModule {}
