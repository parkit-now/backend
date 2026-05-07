import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { SupabaseAuthService } from './supabase-auth.service';
import { SupabaseJwtService } from './supabase-jwt.service';

/**
 * Auth module — wires Supabase Auth into NestJS.
 *
 * Exposes a thin HTTP wrapper around Supabase Auth (`/auth/register`,
 * `/login`, `/refresh`, `/logout`) so clients hit a single API origin
 * instead of talking to Supabase directly. Token verification on protected
 * routes uses `JwtAuthGuard` + `RolesGuard`.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    SupabaseJwtService,
    SupabaseAuthService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    UsersModule,
    SupabaseJwtService,
    SupabaseAuthService,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
