import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import type { UserMembership } from '@prisma/client';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

/**
 * Metadata key carrying the entity-level role a handler requires.
 * Read by `TenantMembershipGuard` via `Reflector`.
 */
export const ENTITY_ROLE_KEY = 'entityRole';

/**
 * Require a specific entity-level role (`UserMembership.role`) on the
 * `:tenantId` route. `admin` bypasses this (handled by the guard).
 *
 * Example: `@EntityRole(MembershipRole.owner)` — owner-only management action.
 */
export const EntityRole = (role: MembershipRole) =>
  SetMetadata(ENTITY_ROLE_KEY, role);

/**
 * Returns the `UserMembership` attached to the request by
 * `TenantMembershipGuard`. `null` when the caller is an admin without a
 * membership row (admins bypass membership). Use only on routes guarded by
 * `TenantMembershipGuard`.
 */
export const CurrentMembership = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): UserMembership | null | undefined => {
    return ctx.switchToHttp().getRequest<AuthenticatedRequest>().membership;
  },
);
