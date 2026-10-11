import { ConfigService } from '@nestjs/config';
import { LprDetectionStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../storage/storage.service';
import { LprImageRetentionService } from './lpr-image-retention.service';

type FindManyArg = { where: Record<string, unknown>; take?: number };

type RegisteredWhere = {
  status: LprDetectionStatus;
  tenantId: { in: string[] };
  entry: { leftAt: { lt: Date }; OR: unknown[] };
};

type NoiseWhere = {
  tenant: unknown;
  OR: [
    { status: { in: LprDetectionStatus[] }; updatedAt: { lt: Date } },
    { status: LprDetectionStatus; updatedAt: { lt: Date } },
  ];
};

describe('LprImageRetentionService', () => {
  const tenantId = '11111111-1111-7111-8111-111111111111';

  const mockPrisma = {
    tenant: {
      findMany: jest.fn(),
    },
    lprDetectionEvent: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const mockAuditService = { record: jest.fn() };
  const mockStorageService = { remove: jest.fn(), removeMany: jest.fn() };
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

  function eventFindManyArgs(): FindManyArg[] {
    return (
      mockPrisma.lprDetectionEvent.findMany.mock.calls as [FindManyArg][]
    ).map(([arg]) => arg);
  }

  function isRegistered(arg: FindManyArg): boolean {
    return arg.where.status === LprDetectionStatus.registered;
  }
  function isArchived(arg: FindManyArg): boolean {
    return arg.where.archivedAt !== undefined;
  }
  function isNoise(arg: FindManyArg): boolean {
    return arg.where.OR !== undefined && arg.where.tenant !== undefined;
  }

  /** The `lprDetectionEvent.findMany` call for a given tier's `where` shape. */
  function tierCall(tier: 'registered' | 'noise' | 'archived'): FindManyArg {
    const predicate =
      tier === 'registered'
        ? isRegistered
        : tier === 'archived'
          ? isArchived
          : isNoise;
    const match = eventFindManyArgs().find(predicate);
    if (!match) throw new Error(`no ${tier} findMany call captured`);
    return match;
  }

  /** Route each tier's `findMany` to a fixed result, regardless of order. */
  function stubTiers(results: {
    registered?: ReturnType<typeof candidate>[];
    noise?: ReturnType<typeof candidate>[];
    archived?: ReturnType<typeof candidate>[];
  }) {
    mockPrisma.lprDetectionEvent.findMany.mockImplementation(
      (arg: FindManyArg) => {
        if (isRegistered(arg)) return Promise.resolve(results.registered ?? []);
        if (isArchived(arg)) return Promise.resolve(results.archived ?? []);
        return Promise.resolve(results.noise ?? []);
      },
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tenant.findMany.mockResolvedValue([
      { id: tenantId, lprImageRetentionDays: 90 },
    ]);
    mockPrisma.lprDetectionEvent.findMany.mockResolvedValue([]);
  });

  it('only logs candidate counts and purges nothing when dry-run is enabled (default)', async () => {
    mockConfigService.get.mockReturnValue(undefined);
    stubTiers({ registered: [candidate('event-1')] });

    const summary = await makeService().run();

    // El resumen es lo que ve quien dispara el job (Cloud Scheduler).
    expect(summary).toEqual({
      dryRun: true,
      registered: 1,
      noise: 0,
      archived: 0,
    });
    expect(mockStorageService.remove.mock.calls).toHaveLength(0);
    expect(mockStorageService.removeMany.mock.calls).toHaveLength(0);
    expect(mockPrisma.lprDetectionEvent.updateMany.mock.calls).toHaveLength(0);
    expect(mockAuditService.record.mock.calls).toHaveLength(0);
  });

  it('deletes the bucket object, clears the image fields and records an audit entry when dry-run is disabled', async () => {
    mockConfigService.get.mockReturnValue('false');
    stubTiers({ registered: [candidate('registered-1')] });

    await makeService().run();

    // Por lote: de a una eran hasta 1500 round-trips secuenciales por corrida.
    expect(mockStorageService.removeMany.mock.calls).toEqual([
      [LPR_DETECTION_IMAGES_BUCKET, [`${tenantId}/registered-1.jpg`]],
    ]);
    expect(mockStorageService.remove.mock.calls).toHaveLength(0);

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

  it('si el lote falla, cae al borrado de a uno y aísla al objeto malo', async () => {
    // Es lo que evita que UN objeto raro le cueste el tier entero al resto.
    mockConfigService.get.mockReturnValue('false');
    stubTiers({ registered: [candidate('bad-1'), candidate('good-1')] });
    mockStorageService.removeMany.mockRejectedValue(
      new Error('storage unavailable'),
    );
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

    const where = tierCall('registered').where as unknown as RegisteredWhere;
    expect(where.status).toBe(LprDetectionStatus.registered);
    expect(where.entry.OR).toEqual([
      { cashSessionId: null },
      { cashSession: { closedAt: { not: null } } },
    ]);
  });

  it('uses each tenant configured retention window for the registered cutoff', async () => {
    mockConfigService.get.mockReturnValue('true');
    const shortTenant = '22222222-2222-7222-8222-222222222222';
    const longTenant = '33333333-3333-7333-8333-333333333333';
    mockPrisma.tenant.findMany.mockResolvedValue([
      { id: shortTenant, lprImageRetentionDays: 30 },
      { id: longTenant, lprImageRetentionDays: 365 },
    ]);

    const before = Date.now();
    await makeService().run();
    const after = Date.now();

    const registered = eventFindManyArgs()
      .filter(isRegistered)
      .map((arg) => arg.where as unknown as RegisteredWhere);
    expect(registered).toHaveLength(2);

    const shortWhere = registered.find((w) =>
      w.tenantId.in.includes(shortTenant),
    );
    const longWhere = registered.find((w) =>
      w.tenantId.in.includes(longTenant),
    );
    if (!shortWhere || !longWhere) throw new Error('missing per-tenant query');

    const day = 24 * 60 * 60 * 1000;
    const shortCutoff = shortWhere.entry.leftAt.lt.getTime();
    const longCutoff = longWhere.entry.leftAt.lt.getTime();
    expect(shortCutoff).toBeGreaterThanOrEqual(before - 30 * day);
    expect(shortCutoff).toBeLessThanOrEqual(after - 30 * day);
    expect(longCutoff).toBeGreaterThanOrEqual(before - 365 * day);
    expect(longCutoff).toBeLessThanOrEqual(after - 365 * day);
  });

  it('caps the registered tier at the per-tier maximum across all tenants', async () => {
    mockConfigService.get.mockReturnValue('true');
    mockPrisma.tenant.findMany.mockResolvedValue([
      { id: 'a1111111-1111-7111-8111-111111111111', lprImageRetentionDays: 30 },
      { id: 'b2222222-2222-7222-8222-222222222222', lprImageRetentionDays: 90 },
    ]);
    const many = Array.from({ length: 400 }, (_, i) => candidate(`e-${i}`));
    mockPrisma.lprDetectionEvent.findMany.mockImplementation(
      (arg: FindManyArg) => Promise.resolve(isRegistered(arg) ? many : []),
    );

    const service = makeService() as unknown as {
      findRegisteredCandidates: () => Promise<unknown[]>;
    };
    const candidates = await service.findRegisteredCandidates();

    expect(candidates).toHaveLength(500);
  });

  it('filters noise candidates by status/pending-timeout and requires no open cash session for the tenant', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const where = tierCall('noise').where as unknown as NoiseWhere;
    expect(where.OR[0].status.in).toEqual([
      LprDetectionStatus.dismissed,
      LprDetectionStatus.suppressed_active_entry,
      LprDetectionStatus.suppressed_pending_event,
      LprDetectionStatus.suppressed_recent_exit,
    ]);
    expect(where.OR[1].status).toBe(LprDetectionStatus.pending);
    expect(where.tenant).toEqual({
      deletedAt: null,
      cashSessions: { none: { closedAt: null } },
    });
  });

  it('gives stuck pending events a shorter floor than reviewed noise', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    const where = tierCall('noise').where as unknown as NoiseWhere;
    const [noiseBranch, pendingBranch] = where.OR;
    expect(pendingBranch.updatedAt.lt.getTime()).toBeGreaterThan(
      noiseBranch.updatedAt.lt.getTime(),
    );
  });

  it('no toca a los estacionamientos dados de baja, en ninguno de los tres tiers', async () => {
    // Carga estructural, no cosmética: durante la ventana de gracia la baja
    // todavía se puede revertir. Si este job le fuera borrando las fotos, al
    // restaurar volverían las filas pero no la evidencia, y en silencio. Las
    // imágenes de un tenant dado de baja las borra `TenantPurgeService`, todas
    // juntas y recién cuando el borrado ya es irreversible.
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    expect(mockPrisma.tenant.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      select: { id: true, lprImageRetentionDays: true },
    });
    for (const tier of ['noise', 'archived'] as const) {
      const where = tierCall(tier).where as { tenant: { deletedAt: unknown } };
      expect(where.tenant.deletedAt).toBeNull();
    }
  });

  it('filters archived candidates without any time floor', async () => {
    mockConfigService.get.mockReturnValue('true');
    await makeService().run();

    expect(tierCall('archived').where).toEqual({
      tenant: { deletedAt: null },
      archivedAt: { not: null },
      imageStoragePath: { not: null },
      imageDeletedAt: null,
    });
  });
});
