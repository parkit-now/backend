import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantMembershipGuard } from './guards/tenant-membership.guard';
import { PermissionsService } from './permissions.service';
import { SupabaseAuthService } from './supabase-auth.service';
import { SupabaseJwtService } from './supabase-jwt.service';

/**
 * Auth module — wires Supabase Auth into NestJS.
 *
 * Exposes a thin HTTP wrapper around Supabase Auth (`/auth/register`,
 * `/login`, `/refresh`, `/logout`, `/me`) so clients hit a single API origin
 * instead of talking to Supabase directly. Token verification on protected
 * routes uses `JwtAuthGuard`; the GLOBAL role is enforced by `RolesGuard`,
 * while entity-level access uses `TenantMembershipGuard` + `PermissionsService`.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    SupabaseJwtService,
    SupabaseAuthService,
    PermissionsService,
    JwtAuthGuard,
    RolesGuard,
    TenantMembershipGuard,
  ],
  exports: [
    UsersModule,
    SupabaseJwtService,
    SupabaseAuthService,
    PermissionsService,
    JwtAuthGuard,
    RolesGuard,
    TenantMembershipGuard,
  ],
})
export class AuthModule {}
