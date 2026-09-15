import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { AuditActions, AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;

  const mockPrisma = {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    // listForTenant pairs findMany+count; resolve them in declaration order.
    $transaction: jest.fn(),
  };

  /** Filters and paging the service handed to `auditLog.findMany`. */
  type FindManyArgs = {
    where: {
      tenantId: string;
      severity?: string;
      action?: string;
      createdAt?: { gte?: Date; lt?: Date };
    };
    skip: number;
    take: number;
  };

  const findManyArgs = (): FindManyArgs =>
    mockPrisma.auditLog.findMany.mock.calls[0]?.[0] as FindManyArgs;

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
        action: AuditActions.ENTITY_APPROVED,
        entityType: 'tenant',
        entityId: 't-1',
        actorUserId: 'u-1',
        tenantId: 't-1',
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'entity.approved',
          entityType: 'tenant',
          entityId: 't-1',
          actorUserId: 'u-1',
          tenantId: 't-1',
          severity: 'info',
          metadata: {},
        },
      });
    });

    it('allows a null tenantId (e.g. application created before approval)', async () => {
      await service.record({
        action: AuditActions.APPLICATION_CREATED,
        entityType: 'application',
        entityId: 'app-1',
        actorUserId: 'u-1',
      });

      const arg = mockPrisma.auditLog.create.mock.calls[0][0] as {
        data: { tenantId: string | null };
      };
      expect(arg.data.tenantId).toBeNull();
    });
  });

  describe('listForTenant', () => {
    const row = {
      id: 'a-1',
      action: 'entity.approved',
      entityType: 'tenant',
      entityId: 't-1',
      severity: 'info',
      metadata: {},
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
      actorUserId: 'u-1',
      tenantId: 't-1',
      actor: { email: 'owner@once.test' },
    };

    const returns = (rows: unknown[], total = rows.length) =>
      mockPrisma.$transaction.mockResolvedValue([rows, total]);

    it('filters by tenantId and maps rows to events', async () => {
      returns([row]);

      const { items, total } = await service.listForTenant('t-1');

      expect(findManyArgs().where.tenantId).toBe('t-1');
      expect(items[0].actorName).toBe('owner@once.test');
      expect(total).toBe(1);
    });

    it('composes severity, action and the instant range', async () => {
      returns([]);
      const from = new Date('2026-08-01T03:00:00Z');
      const to = new Date('2026-09-01T03:00:00Z');

      await service.listForTenant('t-1', {
        severity: 'warn',
        action: AuditActions.ENTITY_PROFILE_UPDATED,
        from,
        to,
      });

      expect(findManyArgs().where).toEqual({
        tenantId: 't-1',
        severity: 'warn',
        action: AuditActions.ENTITY_PROFILE_UPDATED,
        // Half-open, so an event exactly on `to` belongs to the next range.
        createdAt: { gte: from, lt: to },
      });
    });

    it('omits the date filter entirely when neither bound is given', async () => {
      returns([]);

      await service.listForTenant('t-1', { severity: 'info' });

      expect(findManyArgs().where.createdAt).toBeUndefined();
    });

    it('accepts an open-ended range', async () => {
      returns([]);
      const from = new Date('2026-08-01T03:00:00Z');

      await service.listForTenant('t-1', { from });

      expect(findManyArgs().where.createdAt).toEqual({ gte: from });
    });

    it('pages through results and reports the unpaged total', async () => {
      returns([row], 137);

      const { total } = await service.listForTenant('t-1', {
        skip: 40,
        take: 20,
      });

      expect(findManyArgs().skip).toBe(40);
      expect(findManyArgs().take).toBe(20);
      expect(total).toBe(137);
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
        tenantId: 't-1',
        actor: {
          id: 'u-1',
          email: 'owner@once.test',
          role: 'user',
          name: null,
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
        metadata: {},
        createdAt: '2026-05-01T10:00:00.000Z',
      });
    });

    it('uses null actorName when there is no actor', () => {
      const event = AuditService.toEvent({
        id: 'a-2',
        action: 'entity.approved',
        entityType: 'tenant',
        entityId: 't-1',
        severity: 'info',
        metadata: {},
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        actorUserId: null,
        tenantId: 't-1',
        actor: null,
      });

      expect(event.actorName).toBeNull();
    });
  });
});
