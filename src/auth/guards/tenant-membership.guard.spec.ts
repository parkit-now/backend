import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TenantMembershipGuard } from './tenant-membership.guard';

describe('TenantMembershipGuard', () => {
  let guard: TenantMembershipGuard;

  const mockPrisma = {
    userMembership: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMembershipGuard,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    guard = module.get<TenantMembershipGuard>(TenantMembershipGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should allow access if user is admin', async () => {
    const mockContext = createMockContext({
      user: { id: 'user-1', role: 'admin' },
      params: { tenantId: 'tenant-1' },
    });

    const result = await guard.canActivate(mockContext);
    expect(result).toBe(true);
  });

  it('should allow access if membership exists', async () => {
    const mockContext = createMockContext({
      user: { id: 'user-1', role: 'operator' },
      params: { tenantId: 'tenant-1' },
    });

    mockPrisma.userMembership.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    const result = await guard.canActivate(mockContext);
    expect(result).toBe(true);
  });

  it('should throw ForbiddenException if membership does not exist', async () => {
    const mockContext = createMockContext({
      user: { id: 'user-1', role: 'operator' },
      params: { tenantId: 'tenant-1' },
    });

    mockPrisma.userMembership.findUnique.mockResolvedValue(null);

    const resultPromise = guard.canActivate(mockContext);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(resultPromise).rejects.toThrow(ForbiddenException);
  });

  function createMockContext(reqOverrides: any): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => reqOverrides as unknown,
      }),
    } as unknown as ExecutionContext;
  }
});
