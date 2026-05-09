import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Guard that verifies if the authenticated user has a membership
 * for the tenantId specified in the request parameters.
 *
 * This prevents IDOR vulnerabilities where a user with a valid JWT
 * could access data from a different tenant by manipulating the URL.
 */
@Injectable()
export class TenantMembershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    const tenantId = request.params.tenantId;

    if (!user) {
      return false;
    }

    // Admins have global access to all tenants
    if (user.role === 'admin') {
      return true;
    }

    if (!tenantId) {
      // If there's no tenantId in the params, we can't validate membership.
      // This guard should only be used on tenant-scoped routes.
      return true;
    }

    const membership = await this.prisma.userMembership.findUnique({
      where: {
        userId_tenantId: {
          userId: user.id,
          tenantId: tenantId,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenException(
        `User does not have access to tenant: ${tenantId as string}`,
      );
    }

    return true;
  }
}
