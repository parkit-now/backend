import { Test, TestingModule } from '@nestjs/testing';
import type { Tenant, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { EntitiesService } from './entities.service';

const owner: User = {
  id: 'u-owner',
  role: 'user',
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
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
          syncSeq: 1,
          version: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const profile = await service.getProfile('t-1');

      expect(profile.id).toBe('t-1');
      expect(profile.name).toBe('Centro');
      expect(profile.paymentMethods).toHaveLength(1);
      expect(profile.paymentMethods[0].name).toBe('Cash');
      expect(profile.paymentMethods[0].isSystem).toBe(true);
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

    it('merges capacity into settings and sets status', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({
          settings: {
            capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 5 },
          },
        }),
      );
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        status: 'maintenance',
        capacity: { carSpots: 50 },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: {
          status: string;
          settings: { capacity: Record<string, number> };
        };
      };
      expect(updateArg.data.status).toBe('maintenance');
      // Only carSpots changes; the other types keep their previous values.
      expect(updateArg.data.settings.capacity).toEqual({
        carSpots: 50,
        motorcycleSpots: 10,
        bicycleSpots: 5,
      });
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
        syncSeq: 2,
        version: 2,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
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

  describe('deletePaymentMethod', () => {
    it('throws PAYMENT_METHOD_NOT_FOUND when the method does not exist', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.deletePaymentMethod('t-1', owner, 'pm-x'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.paymentMethod.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a system method (PAYMENT_METHOD_SYSTEM_LOCKED)', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-1',
        tenantId: 't-1',
        name: 'Cash',
        isSystem: true,
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.deletePaymentMethod('t-1', owner, 'pm-1'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.paymentMethod.delete).not.toHaveBeenCalled();
    });

    it('deletes a custom method and audits', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-2',
        tenantId: 't-1',
        name: 'Naranja X',
        isSystem: false,
      });
      mockPrisma.paymentMethod.delete.mockResolvedValue({});

      await service.deletePaymentMethod('t-1', owner, 'pm-2');

      expect(mockPrisma.paymentMethod.delete).toHaveBeenCalledWith({
        where: { id: 'pm-2' },
      });
      expect(mockAudit.record).toHaveBeenCalled();
    });
  });

  describe('listAudit', () => {
    beforeEach(() => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockAudit.listForTenant.mockResolvedValue({ items: [], total: 0 });
    });

    it('translates pagination into skip/take and passes the filters', async () => {
      await service.listAudit('t-1', {
        page: 3,
        pageSize: 20,
        severity: 'warn',
        action: 'entity.profile_updated',
        from: '2026-08-01T00:00:00-03:00',
        to: '2026-09-01T00:00:00-03:00',
      });

      expect(mockAudit.listForTenant).toHaveBeenCalledWith('t-1', {
        severity: 'warn',
        action: 'entity.profile_updated',
        from: new Date('2026-08-01T00:00:00-03:00'),
        to: new Date('2026-09-01T00:00:00-03:00'),
        skip: 40,
        take: 20,
      });
    });

    it('wraps the result in the paginated envelope', async () => {
      const event = { id: 'a-1' } as AuditEventDto;
      mockAudit.listForTenant.mockResolvedValue({ items: [event], total: 137 });

      const result = await service.listAudit('t-1', { page: 2, pageSize: 10 });

      // The envelope carries the requested page and the *unpaged* total, so
      // the table can size its pager without a second call.
      expect(result).toEqual({
        items: [event],
        page: 2,
        pageSize: 10,
        total: 137,
      });
    });

    it('leaves the date bounds undefined when not supplied', async () => {
      await service.listAudit('t-1', {});

      expect(mockAudit.listForTenant).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('rejects an inverted range before querying', async () => {
      const failure = await service
        .listAudit('t-1', {
          from: '2026-09-01T00:00:00-03:00',
          to: '2026-08-01T00:00:00-03:00',
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
      expect(mockAudit.listForTenant).not.toHaveBeenCalled();
    });
  });
});
