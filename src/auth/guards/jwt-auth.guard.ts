import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { SupabaseJwtService } from '../supabase-jwt.service';

/**
 * `request.user` shape after this guard succeeds:
 *
 *   - `user` is the row from the `users` table (Prisma `User`),
 *     loaded fresh on every request — role / tenant changes are reflected
 *     immediately even on previously issued tokens.
 *
 * If the Supabase Auth user has no matching row in our `users` table the
 * request is rejected with 401. Provisioning that row is an admin task
 * (see README §Provisioning).
 */
export interface AuthenticatedRequest extends Request {
  user: User;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: SupabaseJwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const payload = await this.jwt.verify(token);
    const user = await this.users.findByIdOrNull(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not provisioned');
    }

    (request as AuthenticatedRequest).user = user;
    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [type, value] = header.split(' ');
    if (type !== 'Bearer' || !value) return null;
    return value;
  }
}
