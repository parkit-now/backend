import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { ApplicationsService } from './applications.service';

const admin: User = {
  id: 'admin-1',
  role: 'admin',
  email: 'admin@once.test',
  name: null,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

describe('ApplicationsService', () => {
  let service: ApplicationsService;

  const tx = {
    tenant: { create: jest.fn() },
    service: { createMany: jest.fn() },
    schedule: { createMany: jest.fn() },
    userMembership: { create: jest.fn() },
    paymentMethod: { createMany: jest.fn() },
    onboardingApplication: { update: jest.fn() },
    user: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const mockPrisma = {
    onboardingApplication: { findUnique: jest.fn(), findMany: jest.fn() },
    applicationDocument: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockStorage = {
    createSignedUrl: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    tx.tenant.create.mockResolvedValue({ id: 'tenant-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  function pendingApp(
    applicantRole = 'user',
    declaredEntity: Record<string, unknown> = {
      name: 'Centro',
      address: 'Av 1',
      legalName: 'ACME',
      cuit: '30123456789',
      email: 'acme@x.com',
      phone: '+541100000000',
      totalSpots: 55,
    },
  ) {
    return {
      id: 'app-1',
      status: 'pending_review',
      tenantId: null,
      declaredEntity,
      applicant: {
        id: 'u-applicant',
        role: applicantRole,
        email: 'applicant@once.test',
      },
    };
  }

  /** `declared_entity` con la dirección ya normalizada por el wizard nuevo. */
  const declaredWithLocation = {
    name: 'Centro',
    legalName: 'ACME',
    cuit: '30123456789',
    email: 'acme@x.com',
    phone: '+541100000000',
    totalSpots: 55,
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
  };

  function tenantCreateData(): Record<string, unknown> {
    return (
      tx.tenant.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
  }

  function approvedListPayload() {
    return {
      id: 'app-1',
      status: 'approved',
      tenantId: 'tenant-1',
      declaredEntity: {
        name: 'Centro',
        legalName: 'ACME',
        email: 'acme@x.com',
        cuit: '30123456789',
      },
      submittedAt: new Date('2026-05-01T00:00:00.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      applicant: { email: 'applicant@once.test' },
      _count: { documents: 2 },
    };
  }

  describe('approve', () => {
    it('runs the full atomic approval and grants an owner membership', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp()) // loadApplication
        .mockResolvedValueOnce(approvedListPayload()); // getById

      const result = await service.approve(admin, 'app-1');

      // One declared entity → one tenant + one membership.
      expect(tx.tenant.create).toHaveBeenCalledTimes(1);
      expect(tx.userMembership.create).toHaveBeenCalledTimes(1);
      // The applicant becomes owner of the new entity.
      const membershipArg = tx.userMembership.create.mock.calls[0][0] as {
        data: { userId: string; tenantId: string; role: string };
      };
      expect(membershipArg.data.userId).toBe('u-applicant');
      expect(membershipArg.data.tenantId).toBe('tenant-1');
      expect(membershipArg.data.role).toBe(MembershipRole.owner);
      // Declared spots -> capacity stored in tenant settings, as ONE number.
      const tenantArg = tx.tenant.create.mock.calls[0][0] as {
        data: { settings: { capacity: { total: number } } };
      };
      expect(tenantArg.data.settings.capacity.total).toBe(55);
      // Services, vehicle types, catalog and system payment methods are seeded
      // by the `AFTER INSERT ON tenants` trigger, NOT here. Asserting they are
      // NOT created is the point: before, this was the only creation path that
      // did it, and `admin/parkings.create` silently skipped them.
      expect(tx.service.createMany).not.toHaveBeenCalled();
      expect(tx.paymentMethod.createMany).not.toHaveBeenCalled();
      expect(result.status).toBe('approved');
    });

    it('materializa la dirección estructurada declarada en columnas del tenant', async () => {
      // Este es EL bug probable de la feature: si `approve()` no copia los
      // campos, todo lo que cargó el dueño en el wizard se pierde en silencio
      // al aprobar y después no puede vincular Mercado Pago.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('user', declaredWithLocation))
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const data = tenantCreateData();
      expect(data).toMatchObject({
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
      expect(data.geocodedAt).toEqual(new Date('2026-09-13T16:46:17.000Z'));
    });

    it('tolera un declared_entity viejo que sólo tiene `address`', async () => {
      // Borradores en vuelo: se guardaron antes del wizard nuevo. No tienen
      // objeto `location`, y aprobar uno no puede romper ni perder la
      // dirección de display.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp()) // sólo `address: 'Av 1'`
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const data = tenantCreateData();
      expect(data.address).toBe('Av 1');
      expect(data.streetName).toBeNull();
      expect(data.cityName).toBeNull();
      expect(data.latitude).toBeNull();
      expect(data.longitude).toBeNull();
      expect(data.geocodingSource).toBeNull();
      expect(data.geocodedAt).toBeNull();
    });

    it('descarta media coordenada en vez de reventar contra el CHECK', async () => {
      // `tenants_coordinates_paired` rechaza lat sin lng. Un borrador a medio
      // llenar no tiene por qué hacer fallar la aprobación entera.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(
          pendingApp('user', {
            ...declaredWithLocation,
            location: { ...declaredWithLocation.location, longitude: null },
          }),
        )
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const data = tenantCreateData();
      expect(data.latitude).toBeNull();
      expect(data.longitude).toBeNull();
      // El resto de la dirección sí se conserva.
      expect(data.streetName).toBe('Avenida Corrientes');
    });

    it('arma `settings` con el helper en vez de pisar el objeto entero', async () => {
      // El literal `settings: { capacity }` borraba cualquier otra clave de
      // settings. Hoy `capacity` es la única, pero el helper es lo que hace
      // que agregar una segunda no sea un bug silencioso.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp())
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const settings = tenantCreateData().settings as Record<string, unknown>;
      expect(settings).toEqual({ capacity: { total: 55 } });
      // Las semánticas de merge del helper se cubren en
      // `entity-settings.spec.ts`; acá se fija la forma que produce approve().
    });

    it('crea los horarios declarados en la misma transacción, con tenantId', async () => {
      const schedules = [
        { day: 'monday', openMinute: 480, closeMinute: 720 },
        { day: 'monday', openMinute: 720, closeMinute: 1200 },
        { day: 'saturday', openMinute: 0, closeMinute: 1440 },
      ];
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(
          pendingApp('user', { ...declaredWithLocation, schedules }),
        )
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      expect(tx.schedule.createMany).toHaveBeenCalledTimes(1);
      const arg = tx.schedule.createMany.mock.calls[0][0] as {
        data: Record<string, unknown>[];
      };
      expect(arg.data).toEqual(
        schedules.map((r) => ({ ...r, tenantId: 'tenant-1' })),
      );
      // Orden: el tenant existe antes de colgarle horarios.
      expect(tx.tenant.create.mock.invocationCallOrder[0]).toBeLessThan(
        tx.schedule.createMany.mock.invocationCallOrder[0],
      );
    });

    it('aprueba sin horarios ni datos fiscales: no crea schedules y deja null', async () => {
      const minimo = {
        name: 'Centro',
        email: 'acme@x.com',
        phone: '+5491123456789',
        location: declaredWithLocation.location,
      };
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('user', minimo))
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      expect(tx.schedule.createMany).not.toHaveBeenCalled();
      const data = tenantCreateData();
      expect(data.legalName).toBeNull();
      expect(data.cuit).toBeNull();
      expect(data.settings).toEqual({ capacity: { total: 0 } });
    });

    it('aprueba con capacidad 0 cuando el borrador no declara `totalSpots`', async () => {
      // Las plazas SALIERON del wizard de alta: el front ya no manda
      // `totalSpots`. El backend lo sigue tolerando —`entity.totalSpots ?? 0`—
      // y el tenant nace con capacidad 0, que el dueño edita después en
      // `/app/config`. Si esto se rompiera, aprobar una solicitud nueva
      // tiraría un `NaN`/`undefined` adentro de `settings.capacity`.
      const sinPlazas = { ...declaredWithLocation };
      delete (sinPlazas as { totalSpots?: number }).totalSpots;
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('user', sinPlazas))
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const settings = tenantCreateData().settings as Record<string, unknown>;
      expect(settings).toEqual({ capacity: { total: 0 } });
    });

    it('sigue respetando el `totalSpots` de un borrador viejo que lo tenga', async () => {
      // El campo no se eliminó del DTO ni de `approve()`: hay borradores
      // guardados con la forma anterior y aprobarlos no puede perder la
      // capacidad que su dueño ya había declarado.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp('user', declaredWithLocation))
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const settings = tenantCreateData().settings as Record<string, unknown>;
      expect(settings).toEqual({ capacity: { total: 55 } });
    });

    it('aprueba igual un borrador SIN dirección: la obligatoriedad es del formulario', async () => {
      // El domicilio pasó a ser obligatorio en el WIZARD, no en el esquema.
      // Las columnas de `tenants` siguen siendo nullable y hay tenants viejos
      // con `null`: si `approve()` empezara a exigirla, las solicitudes que ya
      // están en revisión quedarían imposibles de aprobar.
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(
          pendingApp('user', {
            name: 'Centro',
            legalName: 'ACME',
            cuit: '30123456789',
            email: 'acme@x.com',
            phone: '+541100000000',
          }),
        )
        .mockResolvedValueOnce(approvedListPayload());

      await service.approve(admin, 'app-1');

      const data = tenantCreateData();
      expect(data.address).toBeNull();
      expect(data.streetName).toBeNull();
      expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    });

    it('rejects approving an application that is not pending_review', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValueOnce({
        ...pendingApp(),
        status: 'draft',
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.approve(admin, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('rejects with a reason and audits', async () => {
      mockPrisma.onboardingApplication.findUnique
        .mockResolvedValueOnce(pendingApp())
        .mockResolvedValueOnce({
          ...approvedListPayload(),
          status: 'rejected',
        });

      await service.reject(admin, 'app-1', { reason: 'Invalid CUIT' });

      const rejectArg = tx.onboardingApplication.update.mock.calls[0][0] as {
        data: { status: string; rejectionReason: string };
      };
      expect(rejectArg.data.status).toBe('rejected');
      expect(rejectArg.data.rejectionReason).toBe('Invalid CUIT');
      expect(tx.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('getDocumentSignedUrl', () => {
    const document = {
      id: 'doc-1',
      applicationId: 'app-1',
      name: 'habilitacion.pdf',
      storagePath: 'applications/u-applicant/app-1/habilitacion.pdf',
      mimeType: 'application/pdf',
    };

    it('mints an inline signed URL by default', async () => {
      mockPrisma.applicationDocument.findFirst.mockResolvedValueOnce(document);
      mockStorage.createSignedUrl.mockResolvedValueOnce(
        'https://signed/inline',
      );

      const result = await service.getDocumentSignedUrl('app-1', 'doc-1');

      expect(mockPrisma.applicationDocument.findFirst).toHaveBeenCalledWith({
        where: { id: 'doc-1', applicationId: 'app-1' },
      });
      // No download option → inline disposition.
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith(
        'application-documents',
        document.storagePath,
        300,
        undefined,
      );
      expect(result).toEqual({ url: 'https://signed/inline', expiresIn: 300 });
    });

    it('forces a download named after the file when disposition=attachment', async () => {
      mockPrisma.applicationDocument.findFirst.mockResolvedValueOnce(document);
      mockStorage.createSignedUrl.mockResolvedValueOnce(
        'https://signed/download',
      );

      await service.getDocumentSignedUrl('app-1', 'doc-1', 'attachment');

      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith(
        'application-documents',
        document.storagePath,
        300,
        { download: 'habilitacion.pdf' },
      );
    });

    it('throws when the document does not belong to the application', async () => {
      mockPrisma.applicationDocument.findFirst.mockResolvedValueOnce(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.getDocumentSignedUrl('app-1', 'missing'),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockStorage.createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
