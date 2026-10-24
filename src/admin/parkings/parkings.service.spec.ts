import { Test, TestingModule } from '@nestjs/testing';
import type { Tenant, User } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { ParkingsService } from './parkings.service';

const admin = { id: 'admin-1', role: 'admin' } as User;

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'p-1',
    name: 'Playa Once',
    legalName: null,
    cuit: null,
    email: null,
    phone: null,
    address: 'Bartolomé Mitre 2500',
    status: 'active',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    deletedAt: null,
    purgeAfter: null,
    ...overrides,
  } as Tenant;
}

describe('ParkingsService', () => {
  let service: ParkingsService;

  const mockPrisma = {
    tenant: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParkingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<ParkingsService>(ParkingsService);
  });

  describe('list', () => {
    it('por defecto oculta los dados de baja', async () => {
      mockPrisma.tenant.findMany.mockResolvedValue([tenant()]);
      mockPrisma.tenant.count.mockResolvedValue(1);

      const result = await service.list({});

      expect(mockPrisma.tenant.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ deletedAt: null }) as unknown,
      });
      expect(result.items[0]).toMatchObject({
        id: 'p-1',
        name: 'Playa Once',
        address: 'Bartolomé Mitre 2500',
      });
      expect(result.total).toBe(1);
    });

    it('con includeDeleted también los trae', async () => {
      mockPrisma.tenant.findMany.mockResolvedValue([]);
      mockPrisma.tenant.count.mockResolvedValue(0);

      await service.list({ includeDeleted: true });

      const [{ where }] = mockPrisma.tenant.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).not.toHaveProperty('deletedAt');
    });
  });

  it('get devuelve el estacionamiento o 404 PARKING_NOT_FOUND', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce(tenant());
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(service.get('p-1')).resolves.toMatchObject({ id: 'p-1' });

    mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(service.get('p-x')).rejects.toMatchObject({
      response: { code: ErrorCodes.PARKING_NOT_FOUND, status: 404 },
    });
  });

  it('create da de alta con los opcionales en null y audita', async () => {
    mockPrisma.tenant.create.mockResolvedValue(tenant({ id: 'nuevo' }));

    await service.create(admin, {
      name: 'Playa Sur',
      address: 'Av. Sur 100',
    });

    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Playa Sur',
        legalName: null,
        cuit: null,
        email: null,
        phone: null,
      }) as unknown,
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditActions.PARKING_CREATED,
        entityId: 'nuevo',
        actorUserId: 'admin-1',
      }),
    );
  });

  describe('update', () => {
    it('sólo pisa los campos que llegan', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(
        tenant({ legalName: 'Once SRL' }),
      );

      await service.update(admin, 'p-1', {
        legalName: 'Once SRL',
        status: 'maintenance',
      });

      expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { legalName: 'Once SRL', status: 'maintenance' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditActions.PARKING_UPDATED }),
      );
    });

    it('la dirección formateada pisa la dirección en una línea', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());

      await service.update(admin, 'p-1', {
        address: 'vieja',
        location: { formatted: 'Av. Corrientes 1234, CABA' },
      });

      const [{ data }] = mockPrisma.tenant.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.address).toBe('Av. Corrientes 1234, CABA');
    });

    it('404 si no existe y no escribe nada', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.update(admin, 'p-x', { name: 'X' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.PARKING_NOT_FOUND },
      });
      expect(mockPrisma.tenant.update).not.toHaveBeenCalled();
    });
  });
});
