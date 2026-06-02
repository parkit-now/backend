import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { PrismaModule } from '../../database/prisma.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Admin user management. `SupabaseAuthService` is provided by the global
 * `AuthModule`, so it does not need to be imported here.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}
