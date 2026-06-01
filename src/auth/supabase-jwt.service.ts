import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Verifies bearer tokens issued by Supabase Auth.
 *
 * Modern Supabase projects (2025+) sign tokens with asymmetric keys
 * (ES256/RS256) and publish a JWKS at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
 * Legacy projects still use HS256 with the project's `SUPABASE_JWT_SECRET`.
 *
 * This service supports both:
 *   - If `SUPABASE_JWT_SECRET` is set, HS256 is accepted using that secret.
 *   - In all cases, the JWKS endpoint is consulted for asymmetric keys.
 *
 * `jose` caches and refreshes JWKS automatically; the network call is paid
 * once on cold start and then on key rotation.
 */
export interface SupabaseJwtPayload extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: Record<string, unknown>;
}

@Injectable()
export class SupabaseJwtService implements OnModuleInit {
  private hsSecret?: Uint8Array;
  private jwks!: JWTVerifyGetKey;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const supabaseUrl = this.config.getOrThrow<string>('SUPABASE_URL');
    this.jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    );

    const secret = this.config.get<string>('SUPABASE_JWT_SECRET');
    if (secret) {
      this.hsSecret = new TextEncoder().encode(secret);
    }
  }

  async verify(token: string): Promise<SupabaseJwtPayload> {
    try {
      const { payload } = await jwtVerify<SupabaseJwtPayload>(
        token,
        async (header, input) => {
          if (header.alg === 'HS256') {
            if (!this.hsSecret) {
              throw new Error(
                'HS256 token received but SUPABASE_JWT_SECRET is unset',
              );
            }
            return this.hsSecret;
          }
          return this.jwks(header, input);
        },
        { algorithms: ['HS256', 'ES256', 'RS256'] },
      );
      if (!payload.sub) {
        throw new Error('JWT missing sub');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
