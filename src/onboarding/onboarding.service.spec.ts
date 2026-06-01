import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { OnboardingService } from './onboarding.service';

const owner: User = {
  id: 'u-owner',
  role: 'owner',
  email: 'owner@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

const driver: User = {
  id: 'u-driver',
  role: 'driver',
  email: 'driver@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

describe('OnboardingService', () => {
  let service: OnboardingService;

  const tx = {
    company: { create: jest.fn(), update: jest.fn() },
    onboardingApplication: { create: jest.fn(), update: jest.fn() },
    user: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const mockPrisma = {
    company: { findFirst: jest.fn() },
    onboardingApplication: { findUnique: jest.fn() },
    companyDocument: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockAudit = { record: jest.fn() };
  const mockAuth = { setUserRole: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: SupabaseAuthService, useValue: mockAuth },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('createCompany', () => {
    it('rejects when the owner already has a company', async () => {
      mockPrisma.company.findFirst.mockResolvedValue({ id: 'existing' });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.createCompany(owner, {
          legalName: 'ACME',
          cuit: '30123456789',
          email: 'acme@x.com',
        }),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates company + draft application + audit', async () => {
      mockPrisma.company.findFirst.mockResolvedValue(null);
      const company = {
        id: 'c-1',
        legalName: 'ACME',
        cuit: '30123456789',
        email: 'acme@x.com',
        phone: null,
        address: null,
        status: 'pending',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      };
      const application = {
        id: 'app-1',
        status: 'draft',
        declaredBranches: [],
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      };
      tx.company.create.mockResolvedValue(company);
      tx.onboardingApplication.create.mockResolvedValue(application);

      const state = await service.createCompany(owner, {
        legalName: 'ACME',
        cuit: '30123456789',
        email: 'acme@x.com',
      });

      expect(tx.company.create).toHaveBeenCalled();
      expect(tx.onboardingApplication.create).toHaveBeenCalledWith({
        data: { companyId: 'c-1', status: 'draft' },
      });
      expect(tx.auditLog.create).toHaveBeenCalled();
      expect(state.company?.id).toBe('c-1');
      expect(state.application?.status).toBe('draft');
      // An owner is not promoted again.
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(mockAuth.setUserRole).not.toHaveBeenCalled();
    });

    it('promotes a driver to owner (DB role + JWT app_metadata)', async () => {
      mockPrisma.company.findFirst.mockResolvedValue(null);
      tx.company.create.mockResolvedValue({
        id: 'c-2',
        legalName: 'ACME',
        cuit: '30123456789',
        email: 'acme@x.com',
        phone: null,
        address: null,
        status: 'pending',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });
      tx.onboardingApplication.create.mockResolvedValue({
        id: 'app-2',
        status: 'draft',
        declaredBranches: [],
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      await service.createCompany(driver, {
        legalName: 'ACME',
        cuit: '30123456789',
        email: 'acme@x.com',
      });

      const roleArg = tx.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { role: string };
      };
      expect(roleArg.where.id).toBe('u-driver');
      expect(roleArg.data.role).toBe('owner');
      expect(mockAuth.setUserRole).toHaveBeenCalledWith('u-driver', 'owner');
    });
  });

  describe('submit', () => {
    function ownedApp(overrides: Record<string, unknown>) {
      return {
        id: 'app-1',
        companyId: 'c-1',
        status: 'draft',
        declaredBranches: [{ name: 'Downtown' }],
        company: { ownerUserId: owner.id },
        ...overrides,
      };
    }

    it('transitions draft → pending_review with at least one branch', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({}),
      );
      mockPrisma.company.findFirst.mockResolvedValue(null); // getMe re-read

      await service.submit(owner, 'app-1');

      expect(tx.onboardingApplication.update).toHaveBeenCalled();
      const updateArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string };
      };
      expect(updateArg.data.status).toBe('pending_review');
      expect(tx.auditLog.create).toHaveBeenCalled();
    });

    it('rejects submit without declared branches', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ declaredBranches: [] }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.submit(owner, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('allows re-submit from pending_review (updates submittedAt)', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'pending_review' }),
      );
      mockPrisma.company.findFirst.mockResolvedValue(null); // getMe re-read

      await service.submit(owner, 'app-1');

      expect(tx.onboardingApplication.update).toHaveBeenCalled();
      const updateArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string; submittedAt: Date };
      };
      expect(updateArg.data.status).toBe('pending_review');
      expect(updateArg.data.submittedAt).toBeInstanceOf(Date);
    });

    it('rejects when the application belongs to another owner', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ company: { ownerUserId: 'someone-else' } }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.submit(owner, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
    });
  });
});
