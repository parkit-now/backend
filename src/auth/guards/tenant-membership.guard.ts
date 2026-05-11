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
    const tenantId = request.params.tenantId as string;

    if (!user) {
      throw new ForbiddenException('User is not authenticated');
    }

    // Admins have global access to all tenants
    if (user.role === 'admin') {
      return true;
    }

    if (!tenantId) {
      // Fail closed: If the guard is applied to a route that doesn't have a tenantId,
      // we must deny access to prevent accidental security bypass.
      throw new ForbiddenException(
        'Missing tenantId in request parameters. This route is misconfigured for tenant validation.',
      );
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
        `User does not have access to tenant: ${tenantId}`,
      );
    }

    return true;
  }
}
