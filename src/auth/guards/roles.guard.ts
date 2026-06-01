import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Guard for the GLOBAL role (`User.role`: `admin | user`). Entity-level
 * authorization (`owner | operator`) is handled by `TenantMembershipGuard` +
 * `@EntityRole`, not here.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      UserRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { user } = request;
    if (!user || !requiredRoles.includes(user.role)) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Insufficient permissions',
        request.url,
        ErrorCodes.FORBIDDEN,
      );
    }
    return true;
  }
}
