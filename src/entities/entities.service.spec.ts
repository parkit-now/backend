import { Test, TestingModule } from '@nestjs/testing';
import type { Tenant, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { EntitiesService } from './entities.service';

const owner: User = {
  id: 'u-owner',
  role: 'owner',
  email: 'owner@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-1',
    name: 'Centro',
    legalName: 'ACME',
    cuit: '30123456789',
    email: 'acme@x.com',
    phone: null,
    address: null,
    status: 'active',
    settings: {},
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EntitiesService', () => {
  let service: EntitiesService;

  const txInner = {
    paymentMethod: { updateMany: jest.fn(), update: jest.fn() },
  };
  const mockPrisma = {
    tenant: { findUnique: jest.fn(), update: jest.fn() },
    paymentMethod: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn(), listForTenant: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof txInner) => unknown) => cb(txInner),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitiesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<EntitiesService>(EntitiesService);
  });

  describe('getProfile', () => {
    it('returns the tenant profile with payment-method summary', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([
        {
          id: 'pm-1',
          type: 'cash',
          name: 'Cash',
          enabled: true,
          isDefault: false,
          isSystem: true,
        },
      ]);

      const profile = await service.getProfile('t-1');

      expect(profile.id).toBe('t-1');
      expect(profile.name).toBe('Centro');
      expect(profile.paymentMethods).toHaveLength(1);
      expect(profile.paymentMethods[0].type).toBe('cash');
    });

    it('throws ENTITY_NOT_FOUND when the tenant does not exist', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.getProfile('t-x')).rejects.toBeInstanceOf(
        FormattedException,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates editable fields and audits', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, { name: 'New Name' });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { name: string };
      };
      expect(updateArg.data.name).toBe('New Name');
      expect(mockAudit.record).toHaveBeenCalled();
    });
  });

  describe('togglePaymentMethod', () => {
    it('throws PAYMENT_METHOD_NOT_FOUND when toggling an unknown method', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.togglePaymentMethod('t-1', owner, 'pm-x', { enabled: false }),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('clears the previous default when setting a new default', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-1',
        tenantId: 't-1',
      });
      txInner.paymentMethod.update.mockResolvedValue({
        id: 'pm-1',
        type: 'cash',
        name: 'Cash',
        enabled: true,
        isDefault: true,
        isSystem: true,
      });

      await service.togglePaymentMethod('t-1', owner, 'pm-1', {
        isDefault: true,
      });

      expect(txInner.paymentMethod.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't-1', isDefault: true, NOT: { id: 'pm-1' } },
        data: { isDefault: false },
      });
      expect(mockAudit.record).toHaveBeenCalled();
    });
  });

  describe('listAudit', () => {
    it('delegates to AuditService.listForTenant', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockAudit.listForTenant.mockResolvedValue([]);

      await service.listAudit('t-1', { limit: 50 });

      expect(mockAudit.listForTenant).toHaveBeenCalledWith('t-1', {
        limit: 50,
        severity: undefined,
      });
    });
  });
});
