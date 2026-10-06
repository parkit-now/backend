import { ConfigService } from '@nestjs/config';
import type { Tenant } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import {
  APPLICATION_DOCUMENTS_BUCKET,
  LPR_DETECTION_IMAGES_BUCKET,
  StorageService,
} from '../../storage/storage.service';
import { TenantPurgeService } from './tenant-purge.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-11-05T04:30:00.000Z');

function deletedTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT,
    name: 'Playa Centro',
    deletedAt: new Date('2026-10-05T12:00:00.000Z'),
    purgeAfter: new Date('2026-11-04T12:00:00.000Z'),
    deletedById: 'admin-1',
    deletedReason: 'Datos de prueba',
    ...overrides,
  } as Tenant;
}

describe('TenantPurgeService', () => {
  /** Todo lo que toca el borrado, en el orden en que lo tocó. */
  let order: string[];

  const tx = {
    auditLog: { deleteMany: jest.fn() },
    onboardingApplication: { deleteMany: jest.fn() },
    vehicle: { deleteMany: jest.fn() },
    vehicleType: { deleteMany: jest.fn() },
    tenant: { delete: jest.fn() },
  };

  const mockPrisma = {
    tenant: { findMany: jest.fn() },
    reservation: { count: jest.fn() },
    lprDetectionEvent: { findMany: jest.fn() },
    applicationDocument: { findMany: jest.fn() },
    auditLog: { count: jest.fn() },
    onboardingApplication: { count: jest.fn() },
    vehicle: { count: jest.fn() },
    vehicleType: { count: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockStorage = { removeMany: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const mockConfig = { get: jest.fn() };

  function makeService(): TenantPurgeService {
    return new TenantPurgeService(
      mockPrisma as unknown as PrismaService,
      mockStorage as unknown as StorageService,
      mockAudit as unknown as AuditService,
      mockConfig as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    order = [];

    mockConfig.get.mockReturnValue('false');
    mockPrisma.tenant.findMany.mockResolvedValue([deletedTenant()]);
    mockPrisma.reservation.count.mockResolvedValue(0);
    mockPrisma.lprDetectionEvent.findMany.mockResolvedValue([
      { imageStoragePath: `images/${TENANT}/a.jpg` },
      { imageStoragePath: `images/${TENANT}/b.jpg` },
    ]);
    mockPrisma.applicationDocument.findMany.mockResolvedValue([
      { storagePath: `${TENANT}/cuit.pdf` },
    ]);
    for (const counter of [
      mockPrisma.auditLog.count,
      mockPrisma.onboardingApplication.count,
      mockPrisma.vehicle.count,
      mockPrisma.vehicleType.count,
    ]) {
      counter.mockResolvedValue(0);
    }

    mockStorage.removeMany.mockImplementation((bucket: string) => {
      order.push(`storage:${bucket}`);
      return Promise.resolve(0);
    });
    for (const [name, fn] of [
      ['db:auditLog', tx.auditLog.deleteMany],
      ['db:applications', tx.onboardingApplication.deleteMany],
      ['db:vehicles', tx.vehicle.deleteMany],
      ['db:vehicleTypes', tx.vehicleType.deleteMany],
      ['db:tenant', tx.tenant.delete],
    ] as const) {
      fn.mockImplementation(() => {
        order.push(name);
        return Promise.resolve({ count: 0 });
      });
    }
    mockPrisma.$transaction.mockImplementation(
      (fn: (client: typeof tx) => unknown) => fn(tx),
    );
  });

  it('borra Storage ANTES que la base', async () => {
    // Las rutas de los archivos viven en la base. Si se borra la base primero
    // y Storage falla, quedan archivos que ya nadie puede encontrar.
    await makeService().run(NOW);

    const firstDb = order.findIndex((step) => step.startsWith('db:'));
    const lastStorage = order
      .map((s) => s.startsWith('storage:'))
      .lastIndexOf(true);
    expect(lastStorage).toBeLessThan(firstDb);
  });

  it('borra los vehículos ANTES que los tipos de vehículo', async () => {
    // `vehicles_tenant_type_fkey` es ON DELETE RESTRICT. Hoy no explota sólo
    // porque Postgres dispara los triggers RI en orden alfabético; si alguna
    // vez se recrea el FK, el orden se invierte. Esto lo vuelve explícito.
    await makeService().run(NOW);

    expect(order.indexOf('db:vehicles')).toBeLessThan(
      order.indexOf('db:vehicleTypes'),
    );
  });

  it('borra el tenant al final, cuando ya no queda nada colgando', async () => {
    await makeService().run(NOW);
    expect(order[order.length - 1]).toBe('db:tenant');
  });

  it('borra a mano las filas que el cascade sólo anonimizaría', async () => {
    // `audit_log` y `onboarding_applications` son ON DELETE SET NULL: el
    // cascade las deja con tenant_id = NULL, invisibles e irrastreables.
    await makeService().run(NOW);
    expect(tx.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
    });
    expect(tx.onboardingApplication.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
    });
  });

  it('vacía los dos buckets', async () => {
    await makeService().run(NOW);
    expect(mockStorage.removeMany).toHaveBeenCalledWith(
      LPR_DETECTION_IMAGES_BUCKET,
      [`images/${TENANT}/a.jpg`, `images/${TENANT}/b.jpg`],
    );
    expect(mockStorage.removeMany).toHaveBeenCalledWith(
      APPLICATION_DOCUMENTS_BUCKET,
      [`${TENANT}/cuit.pdf`],
    );
  });

  it('sólo toma los que ya cumplieron la ventana de gracia', async () => {
    await makeService().run(NOW);
    const { where } = mockPrisma.tenant.findMany.mock.calls[0][0] as {
      where: { deletedAt: unknown; purgeAfter: { lte: Date } };
    };
    expect(where.deletedAt).toEqual({ not: null });
    expect(where.purgeAfter).toEqual({ lte: NOW });
  });

  it('en dry-run no borra nada', async () => {
    mockConfig.get.mockReturnValue(undefined);
    await makeService().run(NOW);
    expect(order).toEqual([]);
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('sólo borra si la variable vale exactamente "false"', async () => {
    // Mismo patrón que la retención de imágenes: cualquier otra cosa es
    // dry-run, incluso no estar definida.
    mockConfig.get.mockReturnValue('FALSE');
    await makeService().run(NOW);
    expect(order).toEqual([]);
  });

  it('saltea el que tiene reembolsos pendientes y lo deja para mañana', async () => {
    // Única guarda dura del sistema, y está acá porque acá es donde se pierde
    // la posibilidad de devolverle la plata a alguien.
    mockPrisma.reservation.count.mockResolvedValue(2);
    await makeService().run(NOW);
    expect(order).toEqual([]);
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('deja constancia con el nombre y los conteos, sin tenantId', async () => {
    // Después de esto el tenant no existe: la FK rechazaría un tenantId, así
    // que el nombre va en metadata o se pierde para siempre.
    mockPrisma.auditLog.count.mockResolvedValue(316);
    await makeService().run(NOW);

    const arg = mockAudit.record.mock.calls[0][0] as {
      action: string;
      tenantId?: string;
      metadata: { name: string; purgedCounts: { auditRows: number } };
    };
    expect(arg.action).toBe('parking.purged');
    expect(arg.tenantId).toBeUndefined();
    expect(arg.metadata.name).toBe('Playa Centro');
    expect(arg.metadata.purgedCounts.auditRows).toBe(316);
  });

  it('un estacionamiento que falla no le cuesta la corrida a los demás', async () => {
    mockPrisma.tenant.findMany.mockResolvedValue([
      deletedTenant({ id: 'bad', name: 'Falla' }),
      deletedTenant(),
    ]);
    mockStorage.removeMany.mockImplementationOnce(() =>
      Promise.reject(new Error('storage unavailable')),
    );

    await makeService().run(NOW);

    expect(tx.tenant.delete).toHaveBeenCalledTimes(1);
    expect(tx.tenant.delete).toHaveBeenCalledWith({ where: { id: TENANT } });
  });
});
