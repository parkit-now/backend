import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, Tenant, User, UserMembership } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { resolvePagination } from '../../utils/pagination/pagination-query.dto';
import {
  AdminUserDetailDto,
  AdminUserMembershipDto,
} from './dto/admin-user-detail.dto';
import { AdminUserDto } from './dto/admin-user.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PaginatedUsersDto } from './dto/paginated-users.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';

const INSTANCE = '/admin/users';

type MembershipWithTenant = UserMembership & { tenant: Tenant };

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly supabaseAuth: SupabaseAuthService,
  ) {}

  async list(query: ListUsersQueryDto): Promise<PaginatedUsersDto> {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const where = AdminUsersService.searchWhere(query.search);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(toAdminUserDto), total, page, pageSize };
  }

  async getDetail(id: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        memberships: {
          include: { tenant: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) {
      throw this.userNotFound(id);
    }
    return {
      ...toAdminUserDto(user),
      memberships: user.memberships.map(toMembershipDto),
    };
  }

  async updateRole(
    admin: User,
    id: string,
    dto: UpdateAdminUserDto,
  ): Promise<AdminUserDto> {
    await this.ensureUserExists(id);

    const user = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
    });

    await this.audit.record({
      action: AuditActions.USER_ROLE_UPDATED,
      entityType: 'user',
      entityId: id,
      actorUserId: admin.id,
      metadata: { role: dto.role },
    });

    return toAdminUserDto(user);
  }

  async remove(admin: User, id: string): Promise<void> {
    const user = await this.ensureUserExists(id);

    // Deleting the Supabase Auth identity cascades to `public.users`
    // (FK ON DELETE CASCADE) and from there to memberships. This is the
    // "complete" deletion: the account can no longer authenticate.
    await this.supabaseAuth.deleteUser(id);

    await this.audit.record({
      action: AuditActions.USER_DELETED,
      entityType: 'user',
      entityId: id,
      actorUserId: admin.id,
      metadata: { email: user.email },
    });
  }

  async addMembership(
    admin: User,
    userId: string,
    dto: CreateMembershipDto,
  ): Promise<AdminUserMembershipDto> {
    await this.ensureUserExists(userId);
    await this.ensureParkingExists(dto.parkingId);

    const existing = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId: dto.parkingId } },
    });
    if (existing) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `User ${userId} already has a membership in parking ${dto.parkingId}`,
        INSTANCE,
        ErrorCodes.MEMBERSHIP_ALREADY_EXISTS,
      );
    }

    const membership = await this.prisma.userMembership.create({
      data: { userId, tenantId: dto.parkingId, role: dto.role },
      include: { tenant: true },
    });

    await this.audit.record({
      action: AuditActions.MEMBERSHIP_CREATED,
      entityType: 'user_membership',
      entityId: userId,
      actorUserId: admin.id,
      tenantId: dto.parkingId,
      metadata: { role: dto.role },
    });

    return toMembershipDto(membership);
  }

  async updateMembership(
    admin: User,
    userId: string,
    parkingId: string,
    dto: UpdateMembershipDto,
  ): Promise<AdminUserMembershipDto> {
    await this.ensureMembershipExists(userId, parkingId);

    const membership = await this.prisma.userMembership.update({
      where: { userId_tenantId: { userId, tenantId: parkingId } },
      data: { role: dto.role },
      include: { tenant: true },
    });

    await this.audit.record({
      action: AuditActions.MEMBERSHIP_UPDATED,
      entityType: 'user_membership',
      entityId: userId,
      actorUserId: admin.id,
      tenantId: parkingId,
      metadata: { role: dto.role },
    });

    return toMembershipDto(membership);
  }

  async removeMembership(
    admin: User,
    userId: string,
    parkingId: string,
  ): Promise<void> {
    await this.ensureMembershipExists(userId, parkingId);

    await this.prisma.userMembership.delete({
      where: { userId_tenantId: { userId, tenantId: parkingId } },
    });

    await this.audit.record({
      action: AuditActions.MEMBERSHIP_DELETED,
      entityType: 'user_membership',
      entityId: userId,
      actorUserId: admin.id,
      tenantId: parkingId,
    });
  }

  private async ensureUserExists(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw this.userNotFound(id);
    }
    return user;
  }

  private async ensureParkingExists(id: string): Promise<void> {
    const parking = await this.prisma.tenant.findUnique({ where: { id } });
    if (!parking) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Parking ${id} not found`,
        INSTANCE,
        ErrorCodes.PARKING_NOT_FOUND,
      );
    }
  }

  private async ensureMembershipExists(
    userId: string,
    parkingId: string,
  ): Promise<void> {
    const membership = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId: parkingId } },
    });
    if (!membership) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `User ${userId} has no membership in parking ${parkingId}`,
        INSTANCE,
        ErrorCodes.MEMBERSHIP_NOT_FOUND,
      );
    }
  }

  private static searchWhere(search?: string): Prisma.UserWhereInput {
    const term = search?.trim();
    if (!term) return {};
    return {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    };
  }

  private userNotFound(id: string): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      `User ${id} not found`,
      INSTANCE,
      ErrorCodes.USER_NOT_FOUND,
    );
  }
}

function toAdminUserDto(user: User): AdminUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function toMembershipDto(
  membership: MembershipWithTenant,
): AdminUserMembershipDto {
  return {
    parkingId: membership.tenantId,
    parkingName: membership.tenant.name,
    role: membership.role,
    createdAt: membership.createdAt,
  };
}
