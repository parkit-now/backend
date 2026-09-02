import { LprDetectionStatus, Prisma, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import {
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../storage/storage.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
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
      count: jest.fn(),
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
  const mockStorageService = {
    upload: jest.fn(),
    createSignedUrl: jest.fn(),
  };
  const mockStorage = mockStorageService as unknown as StorageService;

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
      archivedAt: null,
      archivedByUserId: null,
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
    service = new LprEventsService(
      mockPrisma,
      mockTenantContext,
      mockAudit,
      mockStorage,
    );
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

  it('never lets an upsert resurrect an image the retention job already purged', async () => {
    // A client resending a stale local copy of the event (e.g. the desktop
    // re-upserting the same detection on every camera poll tick) must not be
    // able to bring back imageStoragePath after it was cleared server-side.
    // `imageStoragePath`/`imageUrl` aren't even part of the DTO type anymore,
    // but simulate a client sneaking them into the request body regardless
    // (e.g. an older desktop build, or a hand-crafted request).
    const dtoWithStaleImage = {
      ...dto,
      imageStoragePath: `${tenantId}/${eventId}.jpg`,
      imageUrl: 'https://stale-signed-url.example/old.jpg',
    } as UpsertLprDetectionEventDto;
    const existing = row({ imageStoragePath: null, imageUrl: null });
    mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(existing);
    mockTenant.lprDetectionEvent.updateMany.mockResolvedValue({ count: 1 });
    mockTenant.lprDetectionEvent.findFirstOrThrow.mockResolvedValue(existing);

    await service.upsert(dtoWithStaleImage, actor);

    const updateArg = mockTenant.lprDetectionEvent.updateMany.mock
      .calls[0][0] as {
      data: { imageStoragePath: string | null; imageUrl: string | null };
    };
    expect(updateArg.data.imageStoragePath).toBeNull();
    expect(updateArg.data.imageUrl).toBeNull();
  });

  describe('uploadImage', () => {
    const body = Buffer.from('fake-jpeg-bytes');

    it('uploads to the deterministic path and persists imageStoragePath', async () => {
      const existing = row();
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(existing);
      mockStorageService.upload.mockResolvedValue(undefined);
      mockTenant.lprDetectionEvent.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.lprDetectionEvent.findFirstOrThrow.mockResolvedValue(
        row({ imageStoragePath: `${tenantId}/${eventId}.jpg` }),
      );

      const result = await service.uploadImage(eventId, body, 'image/jpeg');

      expect(mockStorageService.upload).toHaveBeenCalledWith(
        LPR_DETECTION_IMAGES_BUCKET,
        `${tenantId}/${eventId}.jpg`,
        body,
        'image/jpeg',
      );
      const updateArg = mockTenant.lprDetectionEvent.updateMany.mock
        .calls[0][0] as { data: { imageStoragePath: string } };
      expect(updateArg.data.imageStoragePath).toBe(
        `${tenantId}/${eventId}.jpg`,
      );
      expect(result.imageStoragePath).toBe(`${tenantId}/${eventId}.jpg`);
    });

    it('throws 404 when the event does not exist for the tenant', async () => {
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(null);

      const promise = service.uploadImage(eventId, body, 'image/jpeg');

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      expect(mockStorageService.upload).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('archives a dismissed event without changing its status', async () => {
      const archivedAt = new Date('2026-07-01T12:05:00.000Z');
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(
        row({ status: LprDetectionStatus.dismissed }),
      );
      mockTenant.lprDetectionEvent.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.lprDetectionEvent.findFirstOrThrow.mockResolvedValue(
        row({
          status: LprDetectionStatus.dismissed,
          archivedAt,
          archivedByUserId: actor.id,
        }),
      );

      const result = await service.archive(eventId, actor);

      const updateArg = mockTenant.lprDetectionEvent.updateMany.mock
        .calls[0][0] as {
        data: { archivedAt: Date; archivedByUserId: string };
      };
      expect(updateArg.data.archivedAt).toBeInstanceOf(Date);
      expect(updateArg.data.archivedByUserId).toBe(actor.id);
      expect(result.status).toBe(LprDetectionStatus.dismissed);
      expect(result.archivedAt).toBe(archivedAt);
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'lpr_event.archived' }),
      );
    });

    it('rejects non-dismissed events', async () => {
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(
        row({ status: LprDetectionStatus.pending }),
      );

      const promise = service.archive(eventId, actor);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      expect(mockTenant.lprDetectionEvent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('listHistory', () => {
    it('filters by timestamp range + plate, paginates, and returns the total', async () => {
      mockTenant.lprDetectionEvent.findMany.mockResolvedValue([
        row({ location: 'entrada', displayPlate: 'AB 123 CD' }),
      ]);
      mockTenant.lprDetectionEvent.count.mockResolvedValue(37);

      const result = await service.listHistory({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
        plate: 'ab-123-cd',
        page: 2,
        pageSize: 10,
      });

      const findArg = mockTenant.lprDetectionEvent.findMany.mock
        .calls[0][0] as {
        where: {
          lastSeenAt: { gte: Date; lte: Date };
          normalizedText: { startsWith: string };
        };
        skip: number;
        take: number;
        orderBy: unknown;
      };
      expect(findArg.where.lastSeenAt.gte).toEqual(
        new Date('2026-08-01T00:00:00.000Z'),
      );
      expect(findArg.where.lastSeenAt.lte).toEqual(
        new Date('2026-08-31T23:59:59.999Z'),
      );
      // separators stripped + upper-cased so it matches the stored normalizedText
      expect(findArg.where.normalizedText.startsWith).toBe('AB123CD');
      expect(findArg.skip).toBe(10);
      expect(findArg.take).toBe(10);
      expect(findArg.orderBy).toEqual([{ lastSeenAt: 'desc' }]);

      // count uses the same where clause
      expect(mockTenant.lprDetectionEvent.count.mock.calls[0][0]).toEqual({
        where: findArg.where,
      });

      expect(result.total).toBe(37);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.items[0].direction).toBe('ingreso');
      expect(result.items[0].plate).toBe('AB 123 CD');
      expect(result.items[0].hasImage).toBe(false);
    });

    it('maps an exit-lane detection to an egreso and filters by direction', async () => {
      mockTenant.lprDetectionEvent.findMany.mockResolvedValue([
        row({
          location: 'Salida',
          imageStoragePath: `${tenantId}/${eventId}.jpg`,
          imageDeletedAt: new Date('2026-07-05T00:00:00.000Z'),
        }),
      ]);
      mockTenant.lprDetectionEvent.count.mockResolvedValue(1);

      const result = await service.listHistory({ direction: 'egreso' });

      const findArg = mockTenant.lprDetectionEvent.findMany.mock
        .calls[0][0] as { where: { location: unknown } };
      expect(findArg.where.location).toEqual({
        contains: 'salid',
        mode: 'insensitive',
      });
      expect(result.items[0].direction).toBe('egreso');
      // image exists but was purged by the retention job → not available
      expect(result.items[0].hasImage).toBe(false);
    });

    it('negates the exit-lane match when filtering for ingreso', async () => {
      mockTenant.lprDetectionEvent.findMany.mockResolvedValue([]);
      mockTenant.lprDetectionEvent.count.mockResolvedValue(0);

      await service.listHistory({ direction: 'ingreso' });

      const findArg = mockTenant.lprDetectionEvent.findMany.mock
        .calls[0][0] as { where: { NOT: { location: unknown } } };
      expect(findArg.where.NOT).toEqual({
        location: { contains: 'salid', mode: 'insensitive' },
      });
    });
  });

  describe('getImageSignedUrl', () => {
    it('mints a signed URL when the event has a stored image', async () => {
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(
        row({ imageStoragePath: `${tenantId}/${eventId}.jpg` }),
      );
      mockStorageService.createSignedUrl.mockResolvedValue(
        'https://signed.example/image.jpg',
      );

      const result = await service.getImageSignedUrl(eventId);

      expect(mockStorageService.createSignedUrl).toHaveBeenCalledWith(
        LPR_DETECTION_IMAGES_BUCKET,
        `${tenantId}/${eventId}.jpg`,
        300,
      );
      expect(result).toEqual({
        url: 'https://signed.example/image.jpg',
        expiresIn: 300,
      });
    });

    it('throws 404 when the event has no stored image yet', async () => {
      mockTenant.lprDetectionEvent.findFirst.mockResolvedValue(
        row({ imageStoragePath: null }),
      );

      const promise = service.getImageSignedUrl(eventId);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      expect(mockStorageService.createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
