import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { Tenant, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { EntitiesService } from './entities.service';

const owner: User = {
  id: 'u-owner',
  role: 'user',
  email: 'owner@once.test',
  name: null,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-1',
    name: 'Centro',
    legalName: 'ACME',
    cuit: '30123456789',
    email: 'acme@x.com',
    phone: null,
    address: null,
    streetName: null,
    streetNumber: null,
    floor: null,
    cityName: null,
    stateName: null,
    postalCode: null,
    latitude: null,
    longitude: null,
    geocodingSource: null,
    geocodedAt: null,
    status: 'active',
    settings: {},
    lprImageRetentionDays: 30,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EntitiesService', () => {
  let service: EntitiesService;

  const txInner = {
    paymentMethod: { updateMany: jest.fn(), update: jest.fn() },
  };
  const mockPrisma = {
    tenant: { findUnique: jest.fn(), update: jest.fn() },
    paymentMethod: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn(), listForTenant: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof txInner) => unknown) => cb(txInner),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntitiesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<EntitiesService>(EntitiesService);
  });

  describe('getProfile', () => {
    it('returns the tenant profile with payment-method summary', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([
        {
          id: 'pm-1',
          type: 'cash',
          name: 'Cash',
          enabled: true,
          isDefault: false,
          isSystem: true,
          syncSeq: 1,
          version: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const profile = await service.getProfile('t-1');

      expect(profile.id).toBe('t-1');
      expect(profile.name).toBe('Centro');
      expect(profile.lprImageRetentionDays).toBe(30);
      expect(profile.paymentMethods).toHaveLength(1);
      expect(profile.paymentMethods[0].name).toBe('Cash');
      expect(profile.paymentMethods[0].isSystem).toBe(true);
    });

    it('throws ENTITY_NOT_FOUND when the tenant does not exist', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.getProfile('t-x')).rejects.toBeInstanceOf(
        FormattedException,
      );
    });

    it('expone la dirección estructurada, con Decimal coercido a number', async () => {
      // `numeric` vuelve de Prisma como Decimal; el contrato HTTP es JSON.
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({
          address: 'Av. Corrientes 1234, Balvanera, CABA',
          streetName: 'Avenida Corrientes',
          streetNumber: 'S/N',
          cityName: 'Balvanera',
          latitude: new Prisma.Decimal('-34.603722'),
          longitude: new Prisma.Decimal('-58.381592'),
          geocodingSource: 'georef',
          geocodedAt: new Date('2026-09-13T16:46:17.000Z'),
        }),
      );
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      const profile = await service.getProfile('t-1');

      expect(profile.location.formatted).toBe(
        'Av. Corrientes 1234, Balvanera, CABA',
      );
      // Altura como texto: "S/N" es una altura válida en Argentina.
      expect(profile.location.streetNumber).toBe('S/N');
      expect(profile.location.latitude).toBe(-34.603722);
      expect(profile.location.longitude).toBe(-58.381592);
      expect(typeof profile.location.latitude).toBe('number');
      expect(profile.location.geocodingSource).toBe('georef');
      expect(profile.location.geocodedAt).toBe('2026-09-13T16:46:17.000Z');
      // `address` sigue existiendo para los clientes viejos.
      expect(profile.address).toBe('Av. Corrientes 1234, Balvanera, CABA');
    });

    it('un tenant anterior a la migración devuelve la dirección en null, sin romper', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({ address: 'Av. Corrientes 1234, CABA' }),
      );
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      const profile = await service.getProfile('t-1');

      // No hubo backfill: sólo sobrevive la línea de display.
      expect(profile.location.formatted).toBe('Av. Corrientes 1234, CABA');
      expect(profile.location.streetName).toBeNull();
      expect(profile.location.latitude).toBeNull();
      expect(profile.location.geocodingSource).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('updates editable fields and audits', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, { name: 'New Name' });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { name: string };
      };
      expect(updateArg.data.name).toBe('New Name');
      expect(mockAudit.record).toHaveBeenCalled();
    });

    it('persists a new LPR image retention window', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({ lprImageRetentionDays: 60 }),
      );
      mockPrisma.tenant.update.mockResolvedValue(
        tenant({ lprImageRetentionDays: 60 }),
      );
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      const profile = await service.updateProfile('t-1', owner, {
        lprImageRetentionDays: 60,
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { lprImageRetentionDays?: number };
      };
      expect(updateArg.data.lprImageRetentionDays).toBe(60);
      expect(profile.lprImageRetentionDays).toBe(60);
    });

    it('merges capacity into settings and sets status', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({ settings: { capacity: { total: 55 } } }),
      );
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        status: 'maintenance',
        capacity: { total: 80 },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: {
          status: string;
          settings: { capacity: Record<string, number> };
        };
      };
      expect(updateArg.data.status).toBe('maintenance');
      expect(updateArg.data.settings.capacity).toEqual({ total: 80 });
    });

    it('un capacity sin `total` conserva el valor actual, no lo pone en cero', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({ settings: { capacity: { total: 55 } } }),
      );
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, { capacity: {} });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { settings: { capacity: Record<string, number> } };
      };
      expect(updateArg.data.settings.capacity).toEqual({ total: 55 });
    });

    it('persiste la dirección estructurada en columnas, no en settings', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        location: {
          formatted: 'Av. Corrientes 1234, Balvanera, CABA',
          streetName: 'Avenida Corrientes',
          streetNumber: '1234',
          floor: 'PB',
          cityName: 'Balvanera',
          stateName: 'Ciudad Autónoma de Buenos Aires',
          postalCode: 'C1043',
          latitude: -34.603722,
          longitude: -58.381592,
          geocodingSource: 'georef',
          geocodedAt: '2026-09-13T16:46:17.000Z',
        },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data).toMatchObject({
        address: 'Av. Corrientes 1234, Balvanera, CABA',
        streetName: 'Avenida Corrientes',
        streetNumber: '1234',
        floor: 'PB',
        cityName: 'Balvanera',
        stateName: 'Ciudad Autónoma de Buenos Aires',
        postalCode: 'C1043',
        latitude: -34.603722,
        longitude: -58.381592,
        geocodingSource: 'georef',
      });
      expect(updateArg.data.geocodedAt).toEqual(
        new Date('2026-09-13T16:46:17.000Z'),
      );
      // La dirección NO va al jsonb: si fuera ahí, el próximo literal que
      // escriba `settings` la borra sin avisar (ver el bug de `approve`).
      expect(updateArg.data.settings).toBeUndefined();
    });

    it('sólo toca los campos de dirección presentes (patch, no reemplazo)', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        location: { floor: '3 B' },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data.floor).toBe('3 B');
      // Omitidos ⇒ ausentes del update: Prisma los deja como están. Si
      // aparecieran como `null`, editar el piso borraría la calle entera.
      expect('streetName' in updateArg.data).toBe(false);
      expect('latitude' in updateArg.data).toBe(false);
      expect('address' in updateArg.data).toBe(false);
    });

    it('un `null` explícito borra el campo de dirección', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        location: { latitude: null, longitude: null },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data.latitude).toBeNull();
      expect(updateArg.data.longitude).toBeNull();
    });

    it('`location.formatted` le gana al `address` plano legacy', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, {
        address: 'lo que escribió el usuario a mano',
        location: { formatted: 'Av. Corrientes 1234, Balvanera, CABA' },
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { address: string };
      };
      expect(updateArg.data.address).toBe(
        'Av. Corrientes 1234, Balvanera, CABA',
      );
    });

    it('lee la forma vieja de tres contadores sumándola', async () => {
      // Una fila escrita por un deploy anterior a la migración devolvería
      // `total: 0` en silencio, y un dueño con 55 plazas vería cero.
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenant({
          settings: {
            capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 5 },
          },
        }),
      );
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, { capacity: {} });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { settings: { capacity: Record<string, number> } };
      };
      expect(updateArg.data.settings.capacity).toEqual({ total: 55 });
    });
  });

  describe('togglePaymentMethod', () => {
    it('throws PAYMENT_METHOD_NOT_FOUND when toggling an unknown method', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.togglePaymentMethod('t-1', owner, 'pm-x', { enabled: false }),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('clears the previous default when setting a new default', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-1',
        tenantId: 't-1',
      });
      txInner.paymentMethod.update.mockResolvedValue({
        id: 'pm-1',
        type: 'cash',
        name: 'Cash',
        enabled: true,
        isDefault: true,
        isSystem: true,
        syncSeq: 2,
        version: 2,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      await service.togglePaymentMethod('t-1', owner, 'pm-1', {
        isDefault: true,
      });

      expect(txInner.paymentMethod.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't-1', isDefault: true, NOT: { id: 'pm-1' } },
        data: { isDefault: false },
      });
      expect(mockAudit.record).toHaveBeenCalled();
    });
  });

  describe('deletePaymentMethod', () => {
    it('throws PAYMENT_METHOD_NOT_FOUND when the method does not exist', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.deletePaymentMethod('t-1', owner, 'pm-x'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.paymentMethod.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a system method (PAYMENT_METHOD_SYSTEM_LOCKED)', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-1',
        tenantId: 't-1',
        name: 'Cash',
        isSystem: true,
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.deletePaymentMethod('t-1', owner, 'pm-1'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.paymentMethod.delete).not.toHaveBeenCalled();
    });

    it('deletes a custom method and audits', async () => {
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-2',
        tenantId: 't-1',
        name: 'Naranja X',
        isSystem: false,
      });
      mockPrisma.paymentMethod.delete.mockResolvedValue({});

      await service.deletePaymentMethod('t-1', owner, 'pm-2');

      expect(mockPrisma.paymentMethod.delete).toHaveBeenCalledWith({
        where: { id: 'pm-2' },
      });
      expect(mockAudit.record).toHaveBeenCalled();
    });
  });

  describe('listAudit', () => {
    it('delegates to AuditService.listForTenant', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockAudit.listForTenant.mockResolvedValue([]);

      await service.listAudit('t-1', { limit: 50 });

      expect(mockAudit.listForTenant).toHaveBeenCalledWith('t-1', {
        limit: 50,
        severity: undefined,
      });
    });
  });
});
