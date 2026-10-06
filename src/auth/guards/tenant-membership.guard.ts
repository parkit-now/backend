import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { ENTITY_ROLE_KEY } from '../decorators/entity-role.decorator';
import { PermissionsService } from '../permissions.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Verifies the authenticated user can act on the `:tenantId` entity.
 *
 *   1. `admin` → bypass (full access to every tenant).
 *   2. otherwise require a `UserMembership` for `(userId, tenantId)`; 403 if
 *      missing (ENTITY_NO_ACCESS). Prevents IDOR via URL manipulation.
 *   3. if the tenant is soft-deleted, 410 Gone (ENTITY_DELETED) — checked
 *      AFTER membership so a non-member still gets 403 and learns nothing.
 *      Admins never reach this: they bypass above, which is what lets them
 *      restore a deleted parking.
 *   4. the membership is attached to `request.membership` for downstream
 *      decorators/services (`@CurrentMembership()`).
 *   5. if the handler declares `@EntityRole(...)` and the caller is not admin,
 *      enforce the required entity role (owner-only management actions) via
 *      `PermissionsService`; 403 ENTITY_INSUFFICIENT_ROLE otherwise.
 */
@Injectable()
export class TenantMembershipGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    const tenantId = request.params.tenantId as string | undefined;

    if (!user) {
      throw this.forbidden(
        request.url,
        'User is not authenticated',
        ErrorCodes.UNAUTHORIZED,
      );
    }

    // Admins bypass membership entirely.
    if (this.permissions.isAdmin(user)) {
      request.membership = null;
      return true;
    }

    if (!tenantId) {
      // Fail closed: a misconfigured route without :tenantId must not pass.
      throw this.forbidden(
        request.url,
        'Missing tenantId in request parameters. This route is misconfigured for tenant validation.',
        ErrorCodes.FORBIDDEN,
      );
    }

    const membership = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      include: { tenant: { select: { deletedAt: true } } },
    });

    if (!membership) {
      throw this.forbidden(
        request.url,
        `User does not have access to tenant: ${tenantId}`,
        ErrorCodes.ENTITY_NO_ACCESS,
      );
    }

    // Dado de baja: 410 Gone. Va DESPUÉS de la verificación de membresía para
    // no filtrarle a un extraño que ese tenant existió — quien no es miembro
    // sigue viendo 403, igual que antes.
    if (membership.tenant.deletedAt) {
      throw new FormattedException(
        'Gone',
        HttpStatus.GONE,
        `Tenant ${tenantId} was deleted`,
        request.url,
        ErrorCodes.ENTITY_DELETED,
      );
    }

    // Se adjunta el `UserMembership` pelado, sin el `tenant` que trajo el
    // include: los consumidores (`@CurrentMembership()`) esperan esa forma.
    request.membership = {
      userId: membership.userId,
      tenantId: membership.tenantId,
      role: membership.role,
      createdAt: membership.createdAt,
    };

    // Owner-only (or otherwise role-gated) handlers.
    const requiredRole = this.reflector.getAllAndOverride<
      MembershipRole | undefined
    >(ENTITY_ROLE_KEY, [context.getHandler(), context.getClass()]);

    if (requiredRole) {
      const allowed =
        requiredRole === MembershipRole.owner
          ? this.permissions.canManageEntity(user, membership)
          : membership.role === requiredRole;
      if (!allowed) {
        throw this.forbidden(
          request.url,
          `This action requires the '${requiredRole}' role on the entity`,
          ErrorCodes.ENTITY_INSUFFICIENT_ROLE,
        );
      }
    }

    return true;
  }

  private forbidden(
    instance: string,
    detail: string,
    code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  ): FormattedException {
    return new FormattedException(
      'Forbidden',
      HttpStatus.FORBIDDEN,
      detail,
      instance,
      code,
    );
  }
}
