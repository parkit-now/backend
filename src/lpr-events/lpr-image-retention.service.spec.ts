import { ConfigService } from '@nestjs/config';
import { LprDetectionStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../storage/storage.service';
import { LprImageRetentionService } from './lpr-image-retention.service';

describe('LprImageRetentionService', () => {
  const tenantId = '11111111-1111-7111-8111-111111111111';

  const mockPrisma = {
    lprDetectionEvent: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const mockAuditService = { record: jest.fn() };
  const mockStorageService = { remove: jest.fn() };
  const mockConfigService = { get: jest.fn() };

  const prisma = mockPrisma as unknown as PrismaService;
  const audit = mockAuditService as unknown as AuditService;
  const storage = mockStorageService as unknown as StorageService;
  const config = mockConfigService as unknown as ConfigService;

  function makeService(): LprImageRetentionService {
    return new LprImageRetentionService(prisma, storage, audit, config);
  }

  function candidate(id: string) {
    return { id, tenantId, imageStoragePath: `${tenantId}/${id}.jpg` };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.lprDetectionEvent.findMany.mockResolvedValue([]);
  });

  it('only logs candidate counts and purges nothing when dry-run is enabled (default)', async () => {
    mockConfigService.get.mockReturnValue(undefined);
    mockPrisma.lprDetectionEvent.findMany.mockResolvedValue([
      candidate('event-1'),
    ]);

    await makeService().run();

    expect(mockStorageService.remove.mock.calls).toHaveLength(0);
    expect(mockPrisma.lprDetectionEvent.updateMany.mock.calls).toHaveLength(0);
    expect(mockAuditService.record.mock.calls).toHaveLength(0);
  });

  it('deletes the bucket object, clears the image fields and records an audit entry when dry-run is disabled', async () => {
    mockConfigService.get.mockReturnValue('false');
    mockPrisma.lprDetectionEvent.findMany
      .mockResolvedValueOnce([candidate('registered-1')]) // registered tier
      .mockResolvedValueOnce([]) // noise tier
      .mockResolvedValueOnce([]); // archived tier

    await makeService().run();

    expect(mockStorageService.remove.mock.calls).toEqual([
      [LPR_DETECTION_IMAGES_BUCKET, `${tenantId}/registered-1.jpg`],
    ]);

    const updateArg = mockPrisma.lprDetectionEvent.updateMany.mock
      .calls[0][0] as {
      where: { id: string; tenantId: string };
      data: {
        imageStoragePath: string | null;
        imageUrl: string | null;
        imageDeletedAt: Date;
      };
    };
    expect(updateArg.where).toEqual({ id: 'registered-1', tenantId });
    expect(updateArg.data.imageStoragePath).toBeNull();
    expect(updateArg.data.imageUrl).toBeNull();
    expect(updateArg.data.imageDeletedAt).toBeInstanceOf(Date);

    const auditArg = mockAuditService.record.mock.calls[0][0] as {
      action: string;
      entityId: string;
      tenantId: string;
      metadata: { tier: string };
    };
    expect(auditArg.action).toBe('lpr_event.image_purged');
    expect(auditArg.entityId).toBe('registered-1');
    expect(auditArg.tenantId).toBe(tenantId);
    expect(auditArg.metadata).toEqual({ tier: 'registered' });
  });

  it('keeps purging remaining candidates when one storage removal fails', async () => {
    mockConfigService.get.mockReturnValue('false');
    mockPrisma.lprDetectionEvent.findMany
      .mockResolvedValueOnce([candidate('bad-1'), candidate('good-1')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockStorageService.remove
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined);

    await makeService().run();

    expect(mockPrisma.lprDetectionEvent.updateMany.mock.calls).toHaveLength(1);
    const updateArg = mockPrisma.lprDetectionEvent.updateMany.mock
      .calls[0][0] as { where: { id: string; tenantId: string } };
    expect(updateArg.where).toEqual({ id: 'good-1', tenantId });
  });

  it('filters registered candidates by status, image presence and cash session closure', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const registeredCall = mockPrisma.lprDetectionEvent.findMany.mock
      .calls[0][0] as {
      where: {
        status: LprDetectionStatus;
        entry: { OR: unknown[] };
      };
    };
    expect(registeredCall.where.status).toBe(LprDetectionStatus.registered);
    expect(registeredCall.where.entry.OR).toEqual([
      { cashSessionId: null },
      { cashSession: { closedAt: { not: null } } },
    ]);
  });

  it('filters noise candidates by status/pending-timeout and requires no open cash session for the tenant', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const noiseCall = mockPrisma.lprDetectionEvent.findMany.mock
      .calls[1][0] as {
      where: {
        tenant: unknown;
        OR: [
          { status: { in: LprDetectionStatus[] } },
          { status: LprDetectionStatus },
        ];
      };
    };
    expect(noiseCall.where.OR[0].status.in).toEqual([
      LprDetectionStatus.dismissed,
      LprDetectionStatus.suppressed_active_entry,
      LprDetectionStatus.suppressed_pending_event,
      LprDetectionStatus.suppressed_recent_exit,
    ]);
    expect(noiseCall.where.OR[1].status).toBe(LprDetectionStatus.pending);
    expect(noiseCall.where.tenant).toEqual({
      cashSessions: { none: { closedAt: null } },
    });
  });

  it('gives stuck pending events a shorter floor than reviewed noise', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const noiseCall = mockPrisma.lprDetectionEvent.findMany.mock
      .calls[1][0] as {
      where: {
        OR: [
          { updatedAt: { lt: Date } },
          { status: LprDetectionStatus; updatedAt: { lt: Date } },
        ];
      };
    };
    const [noiseBranch, pendingBranch] = noiseCall.where.OR;
    expect(pendingBranch.updatedAt.lt.getTime()).toBeGreaterThan(
      noiseBranch.updatedAt.lt.getTime(),
    );
  });

  it('filters archived candidates without any time floor', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const archivedCall = mockPrisma.lprDetectionEvent.findMany.mock
      .calls[2][0] as { where: Record<string, unknown> };
    expect(archivedCall.where).toEqual({
      archivedAt: { not: null },
      imageStoragePath: { not: null },
      imageDeletedAt: null,
    });
  });
});
