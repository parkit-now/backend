import { Injectable } from '@nestjs/common';
import { MembershipRole, UserRole } from '@prisma/client';
import type { User, UserMembership } from '@prisma/client';

/**
 * Centralized, pure (DB-free) authorization rules for the roles-v2 model.
 *
 * Two layers of role live in the system:
 *   - GLOBAL role (`User.role`): `admin | user`. `admin` is god mode and
 *     bypasses every membership check. `user` is everyone else.
 *   - ENTITY role (`UserMembership.role`): `owner | operator`, per tenant.
 *     It is NOT in the JWT — it is resolved per request by
 *     `TenantMembershipGuard` and passed here as `membership`.
 *
 * Every method takes the resolved `(user, membership?)` and returns a boolean.
 * No DB access, no request plumbing — easy to unit-test the whole matrix.
 */
@Injectable()
export class PermissionsService {
  /** Platform-level god mode. */
  isAdmin(user: User): boolean {
    return user.role === UserRole.admin;
  }

  /** View an entity: admin, or any membership (owner or operator). */
  canViewEntity(user: User, membership?: UserMembership | null): boolean {
    return this.isAdmin(user) || !!membership;
  }

  /** Operate an entity (register entries/exits, etc.): same as view. */
  canOperateEntity(user: User, membership?: UserMembership | null): boolean {
    return this.isAdmin(user) || !!membership;
  }

  /**
   * Manage an entity (edit profile, rates, payment methods): admin, or a
   * membership with `role = owner`. Operators cannot manage.
   */
  canManageEntity(user: User, membership?: UserMembership | null): boolean {
    return this.isAdmin(user) || membership?.role === MembershipRole.owner;
  }
}
