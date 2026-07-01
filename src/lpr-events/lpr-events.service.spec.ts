import { LprDetectionStatus, Prisma, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { UpsertLprDetectionEventDto } from './dto/upsert-lpr-detection-event.dto';
import { LprEventsService } from './lpr-events.service';

describe('LprEventsService', () => {
  const tenantId = '11111111-1111-7111-8111-111111111111';
  const eventId = '22222222-2222-7222-8222-222222222222';
  const actor = {
    id: '33333333-3333-7333-8333-333333333333',
    email: 'operator@test.local',
  } as User;

  const mockTenant = {
    lprDetectionEvent: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const mockPrismaService = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };
  const mockPrisma = mockPrismaService as unknown as PrismaService;
  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue(tenantId),
  } as unknown as TenantContextService;
  const mockAuditService = {
    record: jest.fn(),
  };
  const mockAudit = mockAuditService as unknown as AuditService;

  const dto: UpsertLprDetectionEventDto = {
    id: eventId,
    cameraId: 'cam-01',
    location: 'entrada',
    firstSeenAt: '2026-07-01T12:00:00.000Z',
    lastSeenAt: '2026-07-01T12:00:01.000Z',
    rawText: 'ABC123',
    normalizedText: 'ABC123',
    displayPlate: 'ABC 123',
    confidence: 0.91,
    formatValid: true,
    formatType: 'argentina_old',
    qualityStatus: 'valid_high',
    candidates: [],
  };

  function row(
    overrides: Partial<
      Prisma.LprDetectionEventGetPayload<Record<string, never>>
    > = {},
  ): Prisma.LprDetectionEventGetPayload<Record<string, never>> {
    const now = new Date('2026-07-01T12:00:00.000Z');
    return {
      id: eventId,
      tenantId,
      cameraId: 'cam-01',
      location: 'entrada',
      firstSeenAt: now,
      lastSeenAt: now,
      rawText: 'ABC123',
      normalizedText: 'ABC123',
      displayPlate: 'ABC 123',
      confidence: 0.91,
      formatValid: true,
      formatType: 'argentina_old',
      qualityStatus: 'valid_high',
      status: LprDetectionStatus.pending,
      entryId: null,
      reviewedAt: null,
      reviewedByUserId: null,
      imageStoragePath: null,
      imageUrl: null,
      bestCaptureId: null,
      candidates: [],
      version: 1,
      syncSeq: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  let service: LprEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LprEventsService(mockPrisma, mockTenantContext, mockAudit);
  });

  it('creates a pending event through the tenant client without setting tenantId manually', async () => {
    mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(null);
    mockTenant.lprDetectionEvent.create.mockResolvedValue(row());

    const result = await service.upsert(dto, actor);

    expect(result.id).toBe(eventId);
    expect(mockPrismaService.getTenantClient.mock.calls).toHaveLength(1);
    const createArg = mockTenant.lprDetectionEvent.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.tenantId).toBeUndefined();
    expect(mockAuditService.record.mock.calls).toHaveLength(0);
  });

  it('does not downgrade a resolved event when a pending retry arrives', async () => {
    const existing = row({
      status: LprDetectionStatus.registered,
      entryId: '44444444-4444-7444-8444-444444444444',
    });
    mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(existing);
    mockTenant.lprDetectionEvent.updateMany.mockResolvedValue({ count: 1 });
    mockTenant.lprDetectionEvent.findFirstOrThrow.mockResolvedValue(existing);

    const result = await service.upsert(
      { ...dto, status: LprDetectionStatus.pending },
      actor,
    );

    const updateArg = mockTenant.lprDetectionEvent.updateMany.mock
      .calls[0][0] as { data: { status: LprDetectionStatus } };
    expect(updateArg.data.status).toBe(LprDetectionStatus.registered);
    expect(result.status).toBe(LprDetectionStatus.registered);
    expect(mockAuditService.record.mock.calls).toHaveLength(0);
  });
});
