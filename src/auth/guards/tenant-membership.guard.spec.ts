import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import type { UserMembership } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
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
    const membership: UserMembership = {
      userId: 'u-1',
      tenantId: 't-1',
      role: MembershipRole.operator,
      createdAt: new Date(),
    };
    mockPrisma.userMembership.findUnique.mockResolvedValue(membership);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const req = makeRequest({
      user: { id: 'u-1', role: 'user' },
      params: { tenantId: 't-1' },
    });

    expect(await guard.canActivate(makeContext(req))).toBe(true);
    expect(req.membership).toEqual(membership);
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
    mockPrisma.userMembership.findUnique.mockResolvedValue({
      userId: 'u-1',
      tenantId: 't-1',
      role: MembershipRole.owner,
      createdAt: new Date(),
    });
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
    mockPrisma.userMembership.findUnique.mockResolvedValue({
      userId: 'u-1',
      tenantId: 't-1',
      role: MembershipRole.operator,
      createdAt: new Date(),
    });
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
