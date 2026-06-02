import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantsService } from './tenants.service';

const caller = { id: 'user-1' } as User;

describe('TenantsService', () => {
  let service: TenantsService;
  const mockPrisma = {
    userMembership: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
  });

  it('maps memberships to entity summaries', async () => {
    mockPrisma.userMembership.findMany.mockResolvedValue([
      {
        tenantId: 't-1',
        role: 'owner',
        tenant: { name: 'Centro', status: 'active', address: 'Av 1' },
      },
    ]);

    const result = await service.listMine(caller);

    expect(result).toEqual([
      {
        tenantId: 't-1',
        name: 'Centro',
        status: 'active',
        role: 'owner',
        address: 'Av 1',
      },
    ]);
    expect(mockPrisma.userMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('filters by role when provided', async () => {
    mockPrisma.userMembership.findMany.mockResolvedValue([]);

    await service.listMine(caller, 'owner');

    expect(mockPrisma.userMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', role: 'owner' } }),
    );
  });
});
