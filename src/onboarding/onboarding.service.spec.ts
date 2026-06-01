import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { OnboardingService } from './onboarding.service';

const driver: User = {
  id: 'u-driver',
  role: 'user',
  email: 'driver@once.test',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

const validEntity = {
  name: 'Centro',
  address: 'Av 1',
  legalName: 'ACME',
  cuit: '30123456789',
  email: 'acme@x.com',
  phone: '+541100000000',
};

describe('OnboardingService', () => {
  let service: OnboardingService;

  const mockPrisma = {
    onboardingApplication: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    applicationDocument: { create: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('create', () => {
    it('creates a draft application for the current user + audit', async () => {
      mockPrisma.onboardingApplication.create.mockResolvedValue({
        id: 'app-1',
        status: 'draft',
        declaredEntity: validEntity,
        tenantId: null,
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const dto = await service.create(driver, validEntity);

      const createArg = mockPrisma.onboardingApplication.create.mock
        .calls[0][0] as { data: { applicantUserId: string; status: string } };
      expect(createArg.data.applicantUserId).toBe('u-driver');
      expect(createArg.data.status).toBe('draft');
      expect(mockAudit.record).toHaveBeenCalled();
      expect(dto.status).toBe('draft');
      expect(dto.declaredEntity).toMatchObject(validEntity);
    });
  });

  function ownedApp(overrides: Record<string, unknown> = {}) {
    return {
      id: 'app-1',
      status: 'draft',
      declaredEntity: validEntity,
      tenantId: null,
      applicantUserId: driver.id,
      submittedAt: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      _count: { documents: 0 },
      ...overrides,
    };
  }

  describe('update', () => {
    it('merges the declared entity on a draft application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ declaredEntity: { ...validEntity, name: 'New Name' } }),
      );

      await service.update(driver, 'app-1', { name: 'New Name' });

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(updateArg.data.declaredEntity.name).toBe('New Name');
      // Untouched fields are preserved.
      expect(updateArg.data.declaredEntity.cuit).toBe('30123456789');
    });

    it('rejects editing a non-editable (pending_review) application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'pending_review' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.update(driver, 'app-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    it('rejects when the application belongs to another user', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ applicantUserId: 'someone-else' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.update(driver, 'app-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(FormattedException);
    });
  });

  describe('submit', () => {
    it('transitions draft → pending_review', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ status: 'pending_review', submittedAt: new Date() }),
      );

      await service.submit(driver, 'app-1');

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { status: string; submittedAt: Date } };
      expect(updateArg.data.status).toBe('pending_review');
      expect(updateArg.data.submittedAt).toBeInstanceOf(Date);
      expect(mockAudit.record).toHaveBeenCalled();
    });

    it('rejects submitting an already approved application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'approved' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.submit(driver, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });
  });

  describe('addDocument', () => {
    it('registers document metadata for the application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.applicationDocument.create.mockResolvedValue({
        id: 'doc-1',
        name: 'file.pdf',
        storagePath: 'apps/app-1/file.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const doc = await service.addDocument(driver, 'app-1', {
        name: 'file.pdf',
        storagePath: 'apps/app-1/file.pdf',
      });

      expect(doc.id).toBe('doc-1');
      const createArg = mockPrisma.applicationDocument.create.mock
        .calls[0][0] as { data: { applicationId: string } };
      expect(createArg.data.applicationId).toBe('app-1');
    });
  });
});
