import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User, UserRole } from '@prisma/client';
import { AuthError, createClient, type Session } from '@supabase/supabase-js';
import { UsersService } from '../users/users.service';
import { ErrorCode, ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import type { SessionDto } from './dto/session.dto';

/**
 * Wraps the Supabase Auth REST API behind our own HTTP surface.
 * This service intentionally covers email/password + refresh/logout only.
 * Social OAuth (Google/GitHub) is initiated directly by clients via
 * supabase-js; backend authorization still works because JWT validation is
 * provider-agnostic in `SupabaseJwtService`.
 *
 * Two clients live here:
 *   - `admin` — built with `SUPABASE_SERVICE_ROLE_KEY`. Required to create
 *     users administratively and to mirror the global `app_metadata.role`
 *     into the JWT (the anon `signUp` flow can NOT write app_metadata). The
 *     active entity (tenant) is NOT carried in the token: it is resolved per
 *     request from `/tenants/:tenantId` + `TenantMembershipGuard`.
 *   - `anon` — built with `SUPABASE_ANON_KEY`. Used for password sign-in
 *     and refresh-token rotation. Stateless: `persistSession: false`.
 *
 * NEVER expose the admin client through public endpoints. It bypasses RLS
 * and can impersonate any user.
 */
@Injectable()
export class SupabaseAuthService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private admin!: ReturnType<typeof createClient>;
  private anon!: ReturnType<typeof createClient>;

  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');

    const stateless = { autoRefreshToken: false, persistSession: false };
    this.admin = createClient(url, serviceRoleKey, { auth: stateless });
    this.anon = createClient(url, anonKey, { auth: stateless });
  }

  async register(input: {
    email: string;
    password: string;
    role: UserRole;
  }): Promise<{ user: User; session: SessionDto }> {
    const { data: created, error: createErr } =
      await this.admin.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        // Mirror the app role into `app_metadata` so it is baked into the JWT
        // (`app_metadata.role`). Clients read it straight from the session and
        // route by role without an extra `/users/me` round-trip. The DB
        // (`public.users.role`) stays the authorization source of truth;
        // app_metadata only mirrors it for the token.
        app_metadata: { role: input.role },
      });

    if (createErr || !created.user) {
      throw this.toHttp(
        createErr,
        '/auth/register',
        'Failed to create the auth user',
        ErrorCodes.AUTH_REGISTER_FAILED,
      );
    }

    const authUserId = created.user.id;

    let user: User;
    try {
      user = await this.users.create({
        id: authUserId,
        email: input.email,
        role: input.role,
      });
    } catch (err) {
      // Rollback: leave no orphan rows in auth.users when the public.users
      // insert fails.
      await this.admin.auth.admin
        .deleteUser(authUserId)
        .catch((cleanupErr: unknown) => {
          this.logger.error(
            `Failed to rollback auth user ${authUserId} after register error`,
            cleanupErr instanceof Error ? cleanupErr.stack : cleanupErr,
          );
        });
      throw err;
    }

    const session = await this.signInWithPassword(input.email, input.password);
    return { user, session };
  }

  async login(email: string, password: string): Promise<SessionDto> {
    return this.signInWithPassword(email, password);
  }

  async refresh(refreshToken: string): Promise<SessionDto> {
    const { data, error } = await this.anon.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        'Invalid or expired refresh token',
        '/auth/refresh',
        ErrorCodes.AUTH_REFRESH_INVALID,
      );
    }
    return this.toSessionDto(data.session);
  }

  async logout(accessToken: string): Promise<void> {
    // `admin.signOut(jwt)` revokes the refresh token bound to that access
    // token; the access token itself remains valid until its short TTL
    // expires (this is how Supabase Auth works — there's no JWT blacklist).
    const { error } = await this.admin.auth.admin.signOut(accessToken);
    if (error) {
      throw this.toHttp(
        error,
        '/auth/logout',
        'Failed to sign out',
        ErrorCodes.AUTH_LOGOUT_FAILED,
      );
    }
  }

  /**
   * Mirrors a role change into `app_metadata.role` (merged, not replaced) so the
   * next token carries it. The DB (`public.users.role`) stays the authorization
   * source of truth — this only keeps the JWT claim clients route by in sync.
   * NOT transactional with our DB — callers handle failure.
   */
  async setUserRole(userId: string, role: UserRole): Promise<void> {
    const { error } = await this.admin.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    });
    if (error) {
      throw new Error(
        `Failed to set role for user ${userId}: ${error.message}`,
      );
    }
  }

  private async signInWithPassword(
    email: string,
    password: string,
  ): Promise<SessionDto> {
    const { data, error } = await this.anon.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      throw new FormattedException(
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
        error?.message ?? 'Invalid credentials',
        '/auth/login',
        ErrorCodes.AUTH_INVALID_CREDENTIALS,
      );
    }
    return this.toSessionDto(data.session);
  }

  private toSessionDto(session: Session): SessionDto {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      tokenType: session.token_type,
      expiresIn: session.expires_in,
      expiresAt: session.expires_at ?? 0,
    };
  }

  private toHttp(
    error: AuthError | null,
    instance: string,
    fallbackDetail: string,
    fallbackCode: ErrorCode,
  ): FormattedException {
    const status = this.statusForAuthError(error);
    const code = this.codeForAuthError(error) ?? fallbackCode;
    return new FormattedException(
      this.titleForStatus(status),
      status,
      error?.message ?? fallbackDetail,
      instance,
      code,
    );
  }

  private statusForAuthError(error: AuthError | null): HttpStatus {
    if (!error) return HttpStatus.INTERNAL_SERVER_ERROR;
    // Supabase exposes both `status` (HTTP) and `code` (string).
    if (error.status && error.status >= 400 && error.status < 600) {
      return error.status;
    }
    if (error.code === 'email_exists' || error.code === 'user_already_exists') {
      return HttpStatus.CONFLICT;
    }
    if (error.code === 'weak_password' || error.code === 'validation_failed') {
      return HttpStatus.BAD_REQUEST;
    }
    return HttpStatus.BAD_REQUEST;
  }

  private codeForAuthError(error: AuthError | null): ErrorCode | undefined {
    if (!error?.code) return undefined;
    switch (error.code) {
      case 'email_exists':
      case 'user_already_exists':
        return ErrorCodes.AUTH_EMAIL_ALREADY_EXISTS;
      case 'weak_password':
        return ErrorCodes.AUTH_WEAK_PASSWORD;
      default:
        return undefined;
    }
  }

  private titleForStatus(status: HttpStatus): string {
    const map: Partial<Record<HttpStatus, string>> = {
      [HttpStatus.BAD_REQUEST]: 'Bad Request',
      [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
      [HttpStatus.FORBIDDEN]: 'Forbidden',
      [HttpStatus.NOT_FOUND]: 'Not Found',
      [HttpStatus.CONFLICT]: 'Conflict',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
    };
    return map[status] ?? 'Error';
  }
}
