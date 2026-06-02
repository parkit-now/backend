import { Injectable } from '@nestjs/common';
import type { MembershipRole, User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EntitySummaryDto } from './dto/entity-summary.dto';

/**
 * Read-only access to the entities (tenants / parking lots) the caller belongs
 * to. The user↔entity link lives in `user_memberships` (cross-tenant join
 * table), so this uses the plain Prisma client; isolation is the membership
 * filter itself (a user only ever sees their own memberships).
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Entities the caller is a member of, optionally filtered by entity role. */
  async listMine(
    user: User,
    role?: MembershipRole,
  ): Promise<EntitySummaryDto[]> {
    const memberships = await this.prisma.userMembership.findMany({
      where: { userId: user.id, ...(role ? { role } : {}) },
      include: { tenant: true },
      orderBy: { tenant: { name: 'asc' } },
    });

    return memberships.map((m) => ({
      tenantId: m.tenantId,
      name: m.tenant.name,
      status: m.tenant.status,
      role: m.role,
      address: m.tenant.address,
    }));
  }
}
