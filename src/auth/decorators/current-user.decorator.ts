import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

/**
 * Returns the `User` row attached to the request by `JwtAuthGuard`.
 * Use only on routes guarded by `JwtAuthGuard`; otherwise the value
 * is undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    return ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  },
);
