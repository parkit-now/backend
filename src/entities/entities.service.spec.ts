import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { Tenant, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
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
    entryCameraId: null,
    entryCameraLabel: null,
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
    mpAccount: { findUnique: jest.fn() },
    arcaAccount: { findUnique: jest.fn() },
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
      // El `type` tiene que viajar, y viajar SEPARADO del nombre. Sin este
      // campo el desktop no puede snapshotearlo al cobrar y el arqueo de caja
      // vuelve a tener que adivinar buscando "efectivo" en el nombre — que es
      // el bug que rompía la caja de cualquiera que renombrara su método.
      // Ojo al fixture: el método se llama 'Cash' y es `type: 'cash'`; el
      // nombre no dice "efectivo" y aun así el tipo llega bien.
      expect(profile.paymentMethods[0].type).toBe('cash');
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

    it('vincula la cámara de ingreso al estacionamiento', async () => {
      const linked = tenant({
        entryCameraId: 'cam-entrada',
        entryCameraLabel: 'Portón Rivadavia',
      });
      mockPrisma.tenant.findUnique.mockResolvedValue(linked);
      mockPrisma.tenant.update.mockResolvedValue(linked);
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      const profile = await service.updateProfile('t-1', owner, {
        entryCameraId: 'cam-entrada',
        entryCameraLabel: 'Portón Rivadavia',
      });

      const updateArg = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: { entryCameraId?: string | null };
      };
      expect(updateArg.data.entryCameraId).toBe('cam-entrada');
      expect(profile.entryCameraId).toBe('cam-entrada');
      expect(profile.entryCameraLabel).toBe('Portón Rivadavia');
    });

    /**
     * La distinción que importa: `null` desvincula, ausente no toca nada.
     *
     * Si el service usara `?? null` en vez de comparar contra `undefined`,
     * cualquier guardado del perfil —cambiar el teléfono, por ejemplo— borraría
     * la cámara en silencio y la detección automática dejaría de atribuirse.
     */
    it('distingue desvincular la cámara de no tocarla', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockPrisma.tenant.update.mockResolvedValue(tenant());
      mockPrisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.updateProfile('t-1', owner, { entryCameraId: null });
      const unlink = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(unlink.data.entryCameraId).toBeNull();

      mockPrisma.tenant.update.mockClear();
      await service.updateProfile('t-1', owner, { phone: '1122334455' });
      const untouched = mockPrisma.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect('entryCameraId' in untouched.data).toBe(false);
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

    describe('modo de facturación', () => {
      const cash = { id: 'pm-1', tenantId: 't-1', type: 'cash' };

      it('rechaza poner Automática sin ARCA vinculada', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(cash);
        mockPrisma.arcaAccount.findUnique.mockResolvedValue(null);

        const error = await service
          .togglePaymentMethod('t-1', owner, 'pm-1', { invoiceMode: 'auto' })
          .catch((e: unknown) => e);

        expect(
          ((error as FormattedException).getResponse() as { code: string })
            .code,
        ).toBe('ARCA_NOT_LINKED');
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('volver a none se permite siempre, sin mirar ARCA', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(cash);
        txInner.paymentMethod.update.mockResolvedValue({
          ...cash,
          name: 'Efectivo',
          enabled: true,
          isDefault: false,
          isSystem: true,
          invoiceMode: 'none',
          syncSeq: 2,
          version: 2,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        await service.togglePaymentMethod('t-1', owner, 'pm-1', {
          invoiceMode: 'none',
        });

        expect(mockPrisma.arcaAccount.findUnique).not.toHaveBeenCalled();
        expect(txInner.paymentMethod.update).toHaveBeenCalled();
      });
    });

    // La guarda del medio integrado. `unlink()` apaga el `mercadopago_qr`;
    // sin esto el dueño lo volvía a prender por API, el operario lo veía en el
    // modal de egreso y no había con qué cobrar.
    describe('medios respaldados por una integración', () => {
      const mpMethod = { id: 'pm-mp', tenantId: 't-1', type: 'mercadopago_qr' };

      it('rechaza habilitar `mercadopago_qr` sin cuenta vinculada', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);

        const promise = service.togglePaymentMethod('t-1', owner, 'pm-mp', {
          enabled: true,
        });

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(promise).rejects.toBeInstanceOf(FormattedException);
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(promise).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: {
            code: ErrorCodes.PAYMENT_METHOD_INTEGRATION_NOT_LINKED,
          },
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        // El `tenantId` va EXPLÍCITO: `MpAccount` no está en `TENANT_MODELS`,
        // así que Prisma no lo inyecta y sin este `where` se lee la cuenta de
        // otra playa.
        expect(mockPrisma.mpAccount.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { tenantId: 't-1' } }),
        );
      });

      it('deja habilitar `mercadopago_qr` con la cuenta en `linked`', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue({ status: 'linked' });
        txInner.paymentMethod.update.mockResolvedValue({
          ...mpMethod,
          name: 'Mercado Pago',
          enabled: true,
          isDefault: false,
          isSystem: true,
          syncSeq: 3,
          version: 2,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const result = await service.togglePaymentMethod(
          't-1',
          owner,
          'pm-mp',
          { enabled: true },
        );

        expect(result.enabled).toBe(true);
        expect(txInner.paymentMethod.update).toHaveBeenCalled();
      });

      it('rechaza habilitarlo con la cuenta en `revoked`', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue({
          status: 'revoked',
        });

        const promise = service.togglePaymentMethod('t-1', owner, 'pm-mp', {
          enabled: true,
        });

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(promise).rejects.toBeInstanceOf(FormattedException);
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(promise).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      // El caso que NO hay que romper: sin cuenta vinculada es justo cuando el
      // dueño necesita poder sacarlo de la pantalla de cobro.
      it('deja DESHABILITARLO sin cuenta vinculada', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);
        txInner.paymentMethod.update.mockResolvedValue({
          ...mpMethod,
          name: 'Mercado Pago',
          enabled: false,
          isDefault: false,
          isSystem: true,
          syncSeq: 4,
          version: 3,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const result = await service.togglePaymentMethod(
          't-1',
          owner,
          'pm-mp',
          { enabled: false },
        );

        expect(result.enabled).toBe(false);
        expect(mockPrisma.mpAccount.findUnique).not.toHaveBeenCalled();
      });

      // Regresión: la guarda no toca a los medios que no son de integración.
      it('renombrar un medio normal sigue andando', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue({
          id: 'pm-2',
          tenantId: 't-1',
          type: 'other',
        });
        txInner.paymentMethod.update.mockResolvedValue({
          id: 'pm-2',
          type: 'other',
          name: 'Naranja X',
          enabled: true,
          isDefault: false,
          isSystem: false,
          syncSeq: 5,
          version: 2,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-04T00:00:00.000Z'),
        });

        const result = await service.togglePaymentMethod('t-1', owner, 'pm-2', {
          name: 'Naranja X',
        });

        expect(result.name).toBe('Naranja X');
        expect(mockPrisma.mpAccount.findUnique).not.toHaveBeenCalled();
      });

      // Marcar predeterminado NO es neutral: es el medio que queda
      // preseleccionado en el modal de egreso. Sin cuenta viva, el operario se
      // encuentra un QR muerto puesto por defecto.
      it('rechaza marcar `mercadopago_qr` como predeterminado sin cuenta vinculada', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);

        const promise = service.togglePaymentMethod('t-1', owner, 'pm-mp', {
          isDefault: true,
        });

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(promise).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: {
            code: ErrorCodes.PAYMENT_METHOD_INTEGRATION_NOT_LINKED,
          },
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('deja marcarlo predeterminado con la cuenta en `linked`', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue({ status: 'linked' });
        txInner.paymentMethod.update.mockResolvedValue({
          ...mpMethod,
          name: 'Mercado Pago',
          enabled: true,
          isDefault: true,
          isSystem: true,
          syncSeq: 6,
          version: 4,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-05T00:00:00.000Z'),
        });

        const result = await service.togglePaymentMethod(
          't-1',
          owner,
          'pm-mp',
          { isDefault: true },
        );

        expect(result.isDefault).toBe(true);
        expect(txInner.paymentMethod.update).toHaveBeenCalled();
      });

      // Sacarle el predeterminado es lo contrario de ponerlo en circulación:
      // pasa siempre, igual que `enabled: false`.
      it('deja SACARLE el predeterminado sin cuenta vinculada', async () => {
        mockPrisma.paymentMethod.findFirst.mockResolvedValue(mpMethod);
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);
        txInner.paymentMethod.update.mockResolvedValue({
          ...mpMethod,
          name: 'Mercado Pago',
          enabled: true,
          isDefault: false,
          isSystem: true,
          syncSeq: 7,
          version: 5,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-06T00:00:00.000Z'),
        });

        const result = await service.togglePaymentMethod(
          't-1',
          owner,
          'pm-mp',
          { isDefault: false },
        );

        expect(result.isDefault).toBe(false);
        expect(mockPrisma.mpAccount.findUnique).not.toHaveBeenCalled();
      });
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
      expect(mockPrisma.paymentMethod.update).not.toHaveBeenCalled();
    });

    it('soft-deletes a custom method so the deletion reaches offline clients', async () => {
      // NO es un DELETE físico, y el test lo fija a propósito. Un DELETE deja
      // la baja encerrada en la máquina que la ejecutó: el feed incremental
      // sólo puede mencionar filas que existen, así que todos los demás
      // equipos conservaban el medio para siempre y se podía seguir cobrando
      // con él. Estampar `deletedAt` bumpea `syncSeq` y la fila vuelve a
      // aparecer en el feed como tombstone.
      mockPrisma.paymentMethod.findFirst.mockResolvedValue({
        id: 'pm-2',
        tenantId: 't-1',
        name: 'Naranja X',
        isSystem: false,
      });
      mockPrisma.paymentMethod.update.mockResolvedValue({});

      await service.deletePaymentMethod('t-1', owner, 'pm-2');

      expect(mockPrisma.paymentMethod.delete).not.toHaveBeenCalled();
      const [args] = mockPrisma.paymentMethod.update.mock.calls[0] as [
        { where: { id: string }; data: { deletedAt: Date } },
      ];
      expect(args.where).toEqual({ id: 'pm-2' });
      expect(args.data.deletedAt).toBeInstanceOf(Date);
      expect(mockAudit.record).toHaveBeenCalled();
    });

    it('no encuentra un medio ya borrado, así que no re-emite el tombstone', async () => {
      // El segundo borrado tiene que ser 404, no un re-estampado que vuelva a
      // empujar la fila por el feed.
      mockPrisma.paymentMethod.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.deletePaymentMethod('t-1', owner, 'pm-2'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.paymentMethod.update).not.toHaveBeenCalled();
    });
  });

  describe('listAudit', () => {
    beforeEach(() => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant());
      mockAudit.listForTenant.mockResolvedValue({ items: [], total: 0 });
    });

    it('translates pagination into skip/take and passes the filters', async () => {
      await service.listAudit('t-1', {
        page: 3,
        pageSize: 20,
        severity: 'warn',
        action: 'entity.profile_updated',
        from: '2026-08-01T00:00:00-03:00',
        to: '2026-09-01T00:00:00-03:00',
      });

      expect(mockAudit.listForTenant).toHaveBeenCalledWith('t-1', {
        severity: 'warn',
        action: 'entity.profile_updated',
        from: new Date('2026-08-01T00:00:00-03:00'),
        to: new Date('2026-09-01T00:00:00-03:00'),
        skip: 40,
        take: 20,
      });
    });

    it('wraps the result in the paginated envelope', async () => {
      const event = { id: 'a-1' } as AuditEventDto;
      mockAudit.listForTenant.mockResolvedValue({ items: [event], total: 137 });

      const result = await service.listAudit('t-1', { page: 2, pageSize: 10 });

      // The envelope carries the requested page and the *unpaged* total, so
      // the table can size its pager without a second call.
      expect(result).toEqual({
        items: [event],
        page: 2,
        pageSize: 10,
        total: 137,
      });
    });

    it('leaves the date bounds undefined when not supplied', async () => {
      await service.listAudit('t-1', {});

      expect(mockAudit.listForTenant).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('rejects an inverted range before querying', async () => {
      const failure = await service
        .listAudit('t-1', {
          from: '2026-09-01T00:00:00-03:00',
          to: '2026-08-01T00:00:00-03:00',
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
      expect(mockAudit.listForTenant).not.toHaveBeenCalled();
    });
  });
});
