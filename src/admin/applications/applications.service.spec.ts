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

  const tx = {
    tenant: { create: jest.fn() },
    zone: { create: jest.fn() },
    userMembership: { create: jest.fn() },
    paymentMethod: { createMany: jest.fn() },
    onboardingApplication: { update: jest.fn() },
    user: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const mockPrisma = {
    onboardingApplication: { findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };
  const mockAuth = { setUserRole: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    tx.tenant.create.mockResolvedValue({ id: 'tenant-1' });

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

  function pendingApp(applicantRole = 'owner') {
    return {
      id: 'app-1',
      status: 'pending_review',
      tenantId: null,
      declaredEntity: {
        name: 'Centro',
        address: 'Av 1',
        legalName: 'ACME',
        cuit: '30123456789',
        email: 'acme@x.com',
        phone: '+541100000000',
        carSpots: 10,
      },
      applicant: {
        id: 'u-applicant',
        role: applicantRole,
        email: 'applicant@once.test',
      },
    };
  }

  function approvedListPayload() {
    return {
      id: 'app-1',
      status: 'approved',
      tenantId: 'tenant-1',
      declaredEntity: {
        name: 'Centro',
        legalName: 'ACME',
        email: 'acme@x.com',
        cuit: '30123456789',
      },
      submittedAt: new Date('2026-05-01T00:00:00.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      applicant: { email: 'applicant@once.test' },
      _count: { documents: 2 },
    };
  }

  describe('approve', () => {
    it('runs the full atomic approval for an owner applicant', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('owner')) // loadApplication
        .mockResolvedValueOnce(approvedListPayload()); // getById

      const result = await service.approve(admin, 'app-1');

      // One declared entity → one tenant + one membership.
      expect(tx.tenant.create).toHaveBeenCalledTimes(1);
      expect(tx.userMembership.create).toHaveBeenCalledTimes(1);
      // Declared spots → one initial zone.
      expect(tx.zone.create).toHaveBeenCalledTimes(1);
      // System payment methods.
      expect(tx.paymentMethod.createMany).toHaveBeenCalledTimes(1);
      const pmArg = tx.paymentMethod.createMany.mock.calls[0][0] as {
        data: unknown[];
      };
      expect(pmArg.data).toHaveLength(2);
      // Application approved + linked to the created tenant.
      const appUpdateArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string; tenantId: string };
      };
      expect(appUpdateArg.data.status).toBe('approved');
      expect(appUpdateArg.data.tenantId).toBe('tenant-1');
      // An owner is not promoted again.
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(mockAuth.setUserRole).not.toHaveBeenCalled();
      expect(result.status).toBe('approved');
    });

    it('promotes a driver applicant to owner (DB role + JWT mirror)', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('driver'))
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const roleArg = tx.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { role: string };
      };
      expect(roleArg.where.id).toBe('u-applicant');
      expect(roleArg.data.role).toBe('owner');
      expect(mockAuth.setUserRole).toHaveBeenCalledWith('u-applicant', 'owner');
    });

    it('does not fail the approval if mirroring the role fails (audits warn)', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('driver'))
        .mockResolvedValueOnce(approvedListPayload());
      mockAuth.setUserRole.mockRejectedValue(new Error('supabase down'));

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
