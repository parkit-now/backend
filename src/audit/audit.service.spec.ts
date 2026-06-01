import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { AuditActions, AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;

  const mockPrisma = {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('record', () => {
    it('writes an audit row with defaults applied', async () => {
      await service.record({
        action: AuditActions.COMPANY_APPROVED,
        entityType: 'company',
        entityId: 'c-1',
        actorUserId: 'u-1',
        companyId: 'c-1',
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'company.approved',
          entityType: 'company',
          entityId: 'c-1',
          actorUserId: 'u-1',
          companyId: 'c-1',
          severity: 'info',
          metadata: {},
        },
      });
    });
  });

  describe('toEvent', () => {
    it('projects a row (with actor) to the public event shape', () => {
      const createdAt = new Date('2026-05-01T10:00:00.000Z');
      const event = AuditService.toEvent({
        id: 'a-1',
        action: 'application.submitted',
        entityType: 'application',
        entityId: 'app-1',
        severity: 'info',
        metadata: {},
        createdAt,
        actorUserId: 'u-1',
        companyId: 'c-1',
        actor: {
          id: 'u-1',
          email: 'owner@once.test',
          role: 'owner',
          createdAt,
        },
      });

      expect(event).toEqual({
        id: 'a-1',
        action: 'application.submitted',
        actorName: 'owner@once.test',
        entityType: 'application',
        entityId: 'app-1',
        severity: 'info',
        createdAt: '2026-05-01T10:00:00.000Z',
      });
    });

    it('uses null actorName when there is no actor', () => {
      const event = AuditService.toEvent({
        id: 'a-2',
        action: 'company.created',
        entityType: 'company',
        entityId: 'c-1',
        severity: 'info',
        metadata: {},
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        actorUserId: null,
        companyId: 'c-1',
        actor: null,
      });

      expect(event.actorName).toBeNull();
    });
  });
});
