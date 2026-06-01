import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { CompanyOwnerGuard } from './company-owner.guard';

describe('CompanyOwnerGuard', () => {
  let guard: CompanyOwnerGuard;

  const mockPrisma = {
    company: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyOwnerGuard,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    guard = module.get<CompanyOwnerGuard>(CompanyOwnerGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('allows the owner of the company', async () => {
    mockPrisma.company.findUnique.mockResolvedValue({
      id: 'c-1',
      ownerUserId: 'u-1',
    });
    const ctx = createMockContext({
      user: { id: 'u-1', role: 'owner' },
      params: { companyId: 'c-1' },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('allows an admin (global access) even if not the owner', async () => {
    mockPrisma.company.findUnique.mockResolvedValue({
      id: 'c-1',
      ownerUserId: 'someone-else',
    });
    const ctx = createMockContext({
      user: { id: 'admin-1', role: 'admin' },
      params: { companyId: 'c-1' },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a non-owner with COMPANY_NOT_OWNER', async () => {
    mockPrisma.company.findUnique.mockResolvedValue({
      id: 'c-1',
      ownerUserId: 'someone-else',
    });
    const ctx = createMockContext({
      user: { id: 'u-1', role: 'owner' },
      params: { companyId: 'c-1' },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      FormattedException,
    );
  });

  it('rejects when the company does not exist', async () => {
    mockPrisma.company.findUnique.mockResolvedValue(null);
    const ctx = createMockContext({
      user: { id: 'u-1', role: 'owner' },
      params: { companyId: 'c-x' },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      FormattedException,
    );
  });

  function createMockContext(reqOverrides: any): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => reqOverrides as unknown,
      }),
    } as unknown as ExecutionContext;
  }
});
