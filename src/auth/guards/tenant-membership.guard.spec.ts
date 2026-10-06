import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import type { UserMembership } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { PermissionsService } from '../permissions.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';
import { TenantMembershipGuard } from './tenant-membership.guard';

type TestRequest = Pick<AuthenticatedRequest, 'membership'> & {
  user: { id: string; role: 'admin' | 'user' };
  params: { tenantId?: string };
};

describe('TenantMembershipGuard', () => {
  let guard: TenantMembershipGuard;
  let reflector: Reflector;

  const mockPrisma = {
    userMembership: { findUnique: jest.fn() },
  };

  /**
   * Lo que devuelve el `findUnique` del guard: la membresía CON el tenant
   * colgado, porque la consulta lo trae en el mismo round-trip para poder
   * mirarle el `deletedAt`.
   */
  function foundMembership(
    overrides: {
      role?: MembershipRole;
      deletedAt?: Date | null;
    } = {},
  ) {
    return {
      userId: 'u-1',
      tenantId: 't-1',
      role: overrides.role ?? MembershipRole.operator,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      tenant: { deletedAt: overrides.deletedAt ?? null },
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMembershipGuard,
        PermissionsService,
        Reflector,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    guard = module.get(TenantMembershipGuard);
    reflector = module.get(Reflector);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('allows admins and bypasses membership lookup (membership = null)', async () => {
    const req = makeRequest({ user: { id: 'a', role: 'admin' }, params: {} });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(mockPrisma.userMembership.findUnique).not.toHaveBeenCalled();
    expect(req.membership).toBeNull();
  });

  it('allows a member and attaches the membership to the request', async () => {
    const found = foundMembership();
    mockPrisma.userMembership.findUnique.mockResolvedValue(found);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
    // El `tenant` que vino del include NO se adjunta: los consumidores
    // (`@CurrentMembership()`) esperan un `UserMembership` pelado.
    const expected: UserMembership = {
      userId: found.userId,
      tenantId: found.tenantId,
      role: found.role,
      createdAt: found.createdAt,
    };
    expect(req.membership).toEqual(expected);
    expect(req.membership).not.toHaveProperty('tenant');
  });

  it('throws ENTITY_DELETED with 410 when the tenant was soft-deleted', async () => {
    // 410 y no 404: el desktop offline-first distingue "existió y ya no" de un
    // error de red para cerrar la sesión en vez de seguir reintentando.
    mockPrisma.userMembership.findUnique.mockResolvedValue(
      foundMembership({ deletedAt: new Date('2026-10-05T12:00:00.000Z') }),
    );
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      status: HttpStatus.GONE,
      response: { code: ErrorCodes.ENTITY_DELETED },
    });
  });

  it('a non-member of a deleted tenant still gets 403, not 410', async () => {
    // El orden importa: si el chequeo de baja fuera primero, le confirmaría a
    // un extraño que ese estacionamiento existió.
    mockPrisma.userMembership.findUnique.mockResolvedValue(null);
    const req = makeRequest({
      user: { id: 'u-9', role: 'user' },
      params: { tenantId: 't-1' },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
      response: { code: ErrorCodes.ENTITY_NO_ACCESS },
    });
  });

  it('admins bypass the deleted check, which is what lets them restore', async () => {
    const req = makeRequest({
      user: { id: 'a', role: 'admin' },
      params: { tenantId: 't-1' },
    });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(mockPrisma.userMembership.findUnique).not.toHaveBeenCalled();
  });

  it('throws ENTITY_NO_ACCESS when no membership exists', async () => {
    mockPrisma.userMembership.findUnique.mockResolvedValue(null);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    const promise = guard.canActivate(makeContext(req));
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(promise).rejects.toBeInstanceOf(FormattedException);
  });

  it('lets an owner through an @EntityRole(owner) handler', async () => {
    mockPrisma.userMembership.findUnique.mockResolvedValue(
      foundMembership({ role: MembershipRole.owner }),
    );
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(MembershipRole.owner);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
  });

  it('throws ENTITY_INSUFFICIENT_ROLE for an operator on an @EntityRole(owner) handler', async () => {
    mockPrisma.userMembership.findUnique.mockResolvedValue(
      foundMembership({ role: MembershipRole.operator }),
    );
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(MembershipRole.owner);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    const promise = guard.canActivate(makeContext(req));
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(promise).rejects.toBeInstanceOf(FormattedException);
  });

  it('admin bypasses an @EntityRole(owner) handler without a membership', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(MembershipRole.owner);
    const req = makeRequest({
      user: { id: 'a', role: 'admin' },
      params: { tenantId: 't-1' },
    });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(mockPrisma.userMembership.findUnique).not.toHaveBeenCalled();
  });

  function makeRequest(base: Omit<TestRequest, 'membership'>): TestRequest {
    return { ...base, membership: undefined };
  }

  function makeContext(req: TestRequest): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }
});
