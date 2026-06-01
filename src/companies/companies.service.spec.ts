import { Test, TestingModule } from '@nestjs/testing';
import type { Company, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CompaniesService } from './companies.service';

const owner: User = {
  id: 'u-owner',
  role: 'owner',
  email: 'owner@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: 'c-1',
    legalName: 'ACME',
    cuit: '30123456789',
    email: 'acme@x.com',
    phone: null,
    address: null,
    status: 'active',
    ownerUserId: 'u-owner',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CompaniesService', () => {
  let service: CompaniesService;

  const mockPrisma = {
    company: { findFirst: jest.fn(), update: jest.fn() },
    tenant: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    paymentMethod: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn(), listForCompany: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);
  });

  it('aggregates spot counts from zones in listBranches', async () => {
    mockPrisma.tenant.findMany.mockResolvedValue([
      {
        id: 't-1',
        name: 'Downtown',
        address: 'Av 1',
        status: 'active',
        zones: [
          { carSpots: 10, motorcycleSpots: 2, bicycleSpots: 0 },
          { carSpots: 5, motorcycleSpots: 0, bicycleSpots: 3 },
        ],
      },
    ]);

    const [branch] = await service.listBranches(company());

    expect(branch.carSpots).toBe(15);
    expect(branch.motorcycleSpots).toBe(2);
    expect(branch.bicycleSpots).toBe(3);
    expect(branch.totalSpots).toBe(20);
    expect(branch.occupancyPct).toBe(0);
  });

  it('blocks config on a non-active (pending) company', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      service.updateProfile(company({ status: 'pending' }), owner, {
        legalName: 'New Name',
      }),
    ).rejects.toBeInstanceOf(FormattedException);
    expect(mockPrisma.company.update).not.toHaveBeenCalled();
  });

  it('blocks config on a suspended company', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      service.listBranches(company({ status: 'suspended' })),
    ).rejects.toBeInstanceOf(FormattedException);
  });

  it('throws PAYMENT_METHOD_NOT_FOUND when toggling an unknown method', async () => {
    mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      service.togglePaymentMethod(company(), owner, 'pm-x', { enabled: false }),
    ).rejects.toBeInstanceOf(FormattedException);
    expect(mockPrisma.paymentMethod.update).not.toHaveBeenCalled();
  });

  it('getMyProfile returns the profile regardless of status', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(
      company({ status: 'pending' }),
    );

    const profile = await service.getMyProfile(owner);

    expect(profile.id).toBe('c-1');
    expect(profile.status).toBe('pending');
  });
});
