import { HttpStatus, Injectable } from '@nestjs/common';
import {
  MembershipRole,
  Prisma,
  Tenant,
  User,
  UserMembership,
} from '@prisma/client';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { resolvePagination } from '../utils/pagination/pagination-query.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { PaginatedStaffDto } from './dto/paginated-staff.dto';
import { StaffMemberDto } from './dto/staff-member.dto';

const INSTANCE = '/me/staff';

type MembershipWithTenant = UserMembership & { tenant: Tenant };
type UserWithMemberships = User & { memberships: MembershipWithTenant[] };

/**
 * Free-text search over a person's name and email.
 *
 * Mirrors `AdminUsersService.searchWhere`; kept local rather than shared so the
 * admin panel and the owner dashboard can diverge without one silently
 * changing the other's results.
 */
function searchWhere(search?: string): Prisma.UserWhereInput {
  const term = search?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ],
  };
}

function toDto(user: UserWithMemberships): StaffMemberDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    globalRole: user.role,
    createdAt: user.createdAt,
    memberships: user.memberships.map((membership) => ({
      tenantId: membership.tenantId,
      tenantName: membership.tenant.name,
      role: membership.role,
      createdAt: membership.createdAt,
    })),
  };
}

/**
 * Staff directory for a parking-lot owner, across every lot they own.
 *
 * This is the one metrics-adjacent read that is deliberately **cross-tenant**.
 * The dashboard groups by person — someone working at two branches must occupy
 * a single row showing both roles — and that cannot come from a
 * `/tenants/:tenantId` route. `UserMembership` is intentionally excluded from
 * `TENANT_MODELS` for exactly this reason (see the note in `prisma-tenant.ts`),
 * so the plain client is the right tool here.
 *
 * Because there is no `:tenantId` in the URL, there is no `TenantMembershipGuard`
 * either: authorization lives in `resolveScope` below, which is the only thing
 * standing between a caller and other people's staff. Every query in this
 * service must be filtered by its result.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async listStaff(
    caller: User,
    query: ListStaffQueryDto,
  ): Promise<PaginatedStaffDto> {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const scopeIds = await this.resolveScope(caller, query.tenantId);

    // Owning no lots is not an error — the honest answer is "no staff".
    // Returning 403 would also leak that some lot exists to be forbidden from.
    if (scopeIds.length === 0) {
      return { items: [], page, pageSize, total: 0 };
    }

    const where: Prisma.UserWhereInput = {
      memberships: {
        some: {
          tenantId: { in: scopeIds },
          ...(query.role ? { role: query.role } : {}),
        },
      },
      ...searchWhere(query.search),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        skip,
        take,
        include: {
          // Scoped again on the include: the outer `some` only decides who is
          // listed. Without this filter a row would expose the person's roles
          // at lots the caller has no claim to.
          memberships: {
            where: { tenantId: { in: scopeIds } },
            include: { tenant: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(toDto), page, pageSize, total };
  }

  /**
   * The lots whose staff this caller may read.
   *
   * Admins see every lot (global god mode). Everyone else sees only lots where
   * their own membership is `owner` — an operator manages nobody, so their
   * scope is empty.
   */
  private async resolveScope(
    caller: User,
    requestedTenantId?: string,
  ): Promise<string[]> {
    if (this.permissions.isAdmin(caller)) {
      if (requestedTenantId) return [requestedTenantId];
      const tenants = await this.prisma.tenant.findMany({
        select: { id: true },
      });
      return tenants.map((tenant) => tenant.id);
    }

    const owned = await this.prisma.userMembership.findMany({
      where: { userId: caller.id, role: MembershipRole.owner },
      select: { tenantId: true },
    });
    const ownedIds = owned.map((membership) => membership.tenantId);

    if (requestedTenantId) {
      if (!ownedIds.includes(requestedTenantId)) {
        throw new FormattedException(
          'Forbidden',
          HttpStatus.FORBIDDEN,
          `User does not own tenant: ${requestedTenantId}`,
          INSTANCE,
          ErrorCodes.ENTITY_NO_ACCESS,
        );
      }
      return [requestedTenantId];
    }

    return ownedIds;
  }
}
