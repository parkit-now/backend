import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { PrismaService } from '../../database/prisma.service';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { ApplicationsService } from './applications.service';

const admin: User = {
  id: 'admin-1',
  role: 'admin',
  email: 'admin@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

describe('ApplicationsService', () => {
  let service: ApplicationsService;

  let tenantSeq = 0;
  const tx = {
    company: { update: jest.fn() },
    tenant: { create: jest.fn() },
    zone: { create: jest.fn() },
    userMembership: { create: jest.fn() },
    paymentMethod: { createMany: jest.fn() },
    onboardingApplication: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const mockPrisma = {
    onboardingApplication: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };
  const mockAuth = { setActiveTenant: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantSeq = 0;
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    tx.company.update.mockResolvedValue({ id: 'c-1', ownerUserId: 'u-owner' });
    tx.tenant.create.mockImplementation(() => ({
      id: `tenant-${++tenantSeq}`,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: SupabaseAuthService, useValue: mockAuth },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  function pendingApp() {
    return {
      id: 'app-1',
      companyId: 'c-1',
      status: 'pending_review',
      declaredBranches: [{ name: 'Centro', carSpots: 10 }, { name: 'Norte' }],
      company: { id: 'c-1', ownerUserId: 'u-owner' },
    };
  }

  function approvedListPayload() {
    return {
      id: 'app-1',
      status: 'approved',
      declaredBranches: [{ name: 'Centro' }, { name: 'Norte' }],
      submittedAt: new Date('2026-05-01T00:00:00.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      company: {
        legalName: 'ACME',
        email: 'acme@x.com',
        cuit: '30123456789',
        owner: { email: 'owner@once.test' },
      },
      _count: { documents: 2 },
    };
  }

  describe('approve', () => {
    it('runs the full atomic approval and sets the active tenant', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp()) // loadApplication
        .mockResolvedValueOnce(approvedListPayload()); // getById

      const result = await service.approve(admin, 'app-1');

      expect(tx.company.update).toHaveBeenCalledWith({
        where: { id: 'c-1' },
        data: { status: 'active' },
      });
      // 2 declared branches → 2 tenants + 2 memberships
      expect(tx.tenant.create).toHaveBeenCalledTimes(2);
      expect(tx.userMembership.create).toHaveBeenCalledTimes(2);
      // Only the first branch brings spots → 1 initial zone
      expect(tx.zone.create).toHaveBeenCalledTimes(1);
      // System payment methods
      expect(tx.paymentMethod.createMany).toHaveBeenCalledTimes(1);
      const pmArg = tx.paymentMethod.createMany.mock.calls[0][0] as {
        data: unknown[];
      };
      expect(pmArg.data).toHaveLength(2);
      // Application approved
      expect(tx.onboardingApplication.update).toHaveBeenCalled();
      const appUpdateArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string };
      };
      expect(appUpdateArg.data.status).toBe('approved');
      expect(tx.auditLog.create).toHaveBeenCalled();
      // Outside the tx: app_metadata.tenant_id = first tenant
      expect(mockAuth.setActiveTenant).toHaveBeenCalledWith(
        'u-owner',
        'tenant-1',
      );
      expect(result.status).toBe('approved');
    });

    it('does not fail the approval if setting the active tenant fails (audits warn)', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp())
        .mockResolvedValueOnce(approvedListPayload());
      mockAuth.setActiveTenant.mockRejectedValue(new Error('supabase down'));

      expect(await service.approve(admin, 'app-1')).toBeDefined();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'warn' }),
      );
    });

    it('rejects approving an application that is not pending_review', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        ...pendingApp(),
        status: 'draft',
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.approve(admin, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('rejects with a reason and audits', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp())
        .mockResolvedValueOnce({
          ...approvedListPayload(),
          status: 'rejected',
        });

      await service.reject(admin, 'app-1', { reason: 'Invalid CUIT' });

      const rejectArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string; rejectionReason: string };
      };
      expect(rejectArg.data.status).toBe('rejected');
      expect(rejectArg.data.rejectionReason).toBe('Invalid CUIT');
      expect(tx.auditLog.create).toHaveBeenCalled();
    });
  });
});
