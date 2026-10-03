import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import {
  FormattedException,
  FormattedExceptionWithValidation,
} from '../utils/exceptions/http-exception/formatted-exeption';
import { OnboardingService } from './onboarding.service';

const driver: User = {
  id: 'u-driver',
  role: 'user',
  email: 'driver@once.test',
  name: null,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

/**
 * Dirección normalizada por Georef: el camino feliz del wizard. Alcanza sola
 * para enviar a revisión (ver `missingDeclaredAddressFields`).
 */
const georefLocation = {
  formatted: 'Av. Corrientes 1234, Balvanera, CABA',
  streetName: 'Avenida Corrientes',
  streetNumber: '1234',
  cityName: 'Balvanera',
  stateName: 'Ciudad Autónoma de Buenos Aires',
  latitude: -34.603722,
  longitude: -58.381592,
  geocodingSource: 'georef' as const,
  geocodedAt: '2026-09-13T16:46:17.000Z',
};

/** Los cuatro campos a mano, sin Georef. También alcanza. */
const manualLocation = {
  streetName: 'Avenida Corrientes',
  streetNumber: '1234',
  cityName: 'Balvanera',
  stateName: 'Ciudad Autónoma de Buenos Aires',
  geocodingSource: 'manual' as const,
  geocodedAt: '2026-09-13T16:46:17.000Z',
};

const validEntity = {
  name: 'Centro',
  address: 'Av. Corrientes 1234, Balvanera, CABA',
  location: georefLocation,
  legalName: 'ACME',
  cuit: '30123456789',
  email: 'acme@x.com',
  phone: '+541100000000',
};

/** El ProblemDetails que viaja adentro de la excepción. */
function problem(error: unknown): {
  status: number;
  code: string;
  detail: string;
  validationsErrors?: { field: string; reason: string; code: string }[];
} {
  return (error as FormattedException).getResponse() as ReturnType<
    typeof problem
  >;
}

describe('OnboardingService', () => {
  let service: OnboardingService;

  const mockPrisma = {
    onboardingApplication: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    applicationDocument: { create: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  const mon = (openMinute: number, closeMinute: number) => ({
    day: 'monday' as const,
    openMinute,
    closeMinute,
  });

  describe('create', () => {
    it('acepta una solicitud SIN razón social ni CUIT', async () => {
      const { legalName: _l, cuit: _c, ...sinFiscales } = validEntity;
      void _l;
      void _c;
      mockPrisma.onboardingApplication.create.mockResolvedValue({
        id: 'app-1',
        status: 'draft',
        declaredEntity: sinFiscales,
        tenantId: null,
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const dto = await service.create(driver, sinFiscales);

      expect(dto.status).toBe('draft');
      const createArg = mockPrisma.onboardingApplication.create.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect('legalName' in createArg.data.declaredEntity).toBe(false);
      expect('cuit' in createArg.data.declaredEntity).toBe(false);
    });

    it('guarda los horarios declarados válidos (franjas contiguas OK)', async () => {
      const schedules = [mon(480, 720), mon(720, 1200)];
      mockPrisma.onboardingApplication.create.mockResolvedValue({
        id: 'app-1',
        status: 'draft',
        declaredEntity: { ...validEntity, schedules },
        tenantId: null,
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      await service.create(driver, { ...validEntity, schedules });

      const createArg = mockPrisma.onboardingApplication.create.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(createArg.data.declaredEntity.schedules).toEqual(schedules);
    });

    it('responde 422 si un horario tiene open >= close', async () => {
      const error = await service
        .create(driver, { ...validEntity, schedules: [mon(600, 600)] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FormattedExceptionWithValidation);
      expect(problem(error).status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      expect(problem(error).validationsErrors).toEqual([
        expect.objectContaining({
          field: 'declaredEntity.schedules.0',
          code: 'SCHEDULE_INVALID_RANGE',
        }),
      ]);
      expect(mockPrisma.onboardingApplication.create).not.toHaveBeenCalled();
    });

    it('responde 422 si dos horarios se solapan el mismo día', async () => {
      const error = await service
        .create(driver, {
          ...validEntity,
          schedules: [mon(480, 720), mon(600, 900)],
        })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(problem(error).validationsErrors).toEqual([
        expect.objectContaining({
          field: 'declaredEntity.schedules.1',
          code: 'SCHEDULE_OVERLAP',
        }),
      ]);
    });

    it('creates a draft application for the current user + audit', async () => {
      mockPrisma.onboardingApplication.create.mockResolvedValue({
        id: 'app-1',
        status: 'draft',
        declaredEntity: validEntity,
        tenantId: null,
        submittedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const dto = await service.create(driver, validEntity);

      const createArg = mockPrisma.onboardingApplication.create.mock
        .calls[0][0] as { data: { applicantUserId: string; status: string } };
      expect(createArg.data.applicantUserId).toBe('u-driver');
      expect(createArg.data.status).toBe('draft');
      expect(mockAudit.record).toHaveBeenCalled();
      expect(dto.status).toBe('draft');
      expect(dto.declaredEntity).toMatchObject(validEntity);
    });
  });

  function ownedApp(overrides: Record<string, unknown> = {}) {
    return {
      id: 'app-1',
      status: 'draft',
      declaredEntity: validEntity,
      tenantId: null,
      applicantUserId: driver.id,
      submittedAt: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      _count: { documents: 0 },
      ...overrides,
    };
  }

  describe('update', () => {
    it('merges the declared entity on a draft application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ declaredEntity: { ...validEntity, name: 'New Name' } }),
      );

      await service.update(driver, 'app-1', { name: 'New Name' });

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(updateArg.data.declaredEntity.name).toBe('New Name');
      // Untouched fields are preserved.
      expect(updateArg.data.declaredEntity.cuit).toBe('30123456789');
    });

    it('un PATCH con horarios solapados responde 422 y no guarda', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());

      const error = await service
        .update(driver, 'app-1', { schedules: [mon(480, 720), mon(700, 900)] })
        .catch((e: unknown) => e);

      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    it('un PATCH con `schedules` REEMPLAZA la lista entera', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: { ...validEntity, schedules: [mon(480, 720)] },
        }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(ownedApp());

      await service.update(driver, 'app-1', { schedules: [mon(600, 900)] });

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(updateArg.data.declaredEntity.schedules).toEqual([mon(600, 900)]);
    });

    it('un PATCH sin `totalSpots` NO borra el que ya tenía el borrador', async () => {
      // El wizard nuevo dejó de mandar `totalSpots` (las plazas se configuran
      // en `/app/config`). Como `update()` hace MERGE contra el
      // `declaredEntity` guardado, editar un borrador viejo con el wizard
      // nuevo NO le tira abajo la capacidad que su dueño ya había declarado.
      // Si esto pasara a ser un reemplazo, esos borradores se aprobarían con
      // capacidad 0 sin que nadie se entere.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ declaredEntity: { ...validEntity, totalSpots: 55 } }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(ownedApp());

      await service.update(driver, 'app-1', { name: 'New Name' });

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(updateArg.data.declaredEntity.totalSpots).toBe(55);
    });

    it('acepta un PATCH sin dirección: el DTO sigue teniéndola opcional', async () => {
      // El domicilio es obligatorio en el FORMULARIO del wizard, no en el
      // contrato. Volverlo requerido acá dejaría sin poder editar a los
      // borradores que se guardaron sin dirección antes de este cambio.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ declaredEntity: { name: 'Centro' } }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(ownedApp());

      await service.update(driver, 'app-1', { phone: '+541100000001' });

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { declaredEntity: Record<string, unknown> } };
      expect(updateArg.data.declaredEntity.phone).toBe('+541100000001');
      expect(updateArg.data.declaredEntity.address).toBeUndefined();
    });

    it('rejects editing a non-editable (pending_review) application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'pending_review' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.update(driver, 'app-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(FormattedException);
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    it('rejects when the application belongs to another user', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ applicantUserId: 'someone-else' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.update(driver, 'app-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(FormattedException);
    });
  });

  describe('submit', () => {
    it('transitions draft → pending_review', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ status: 'pending_review', submittedAt: new Date() }),
      );

      await service.submit(driver, 'app-1');

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { status: string; submittedAt: Date } };
      expect(updateArg.data.status).toBe('pending_review');
      expect(updateArg.data.submittedAt).toBeInstanceOf(Date);
      expect(mockAudit.record).toHaveBeenCalled();
    });

    it('envía a revisión con horarios válidos y sin datos fiscales', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: {
            name: 'Centro',
            location: georefLocation,
            schedules: [mon(480, 720), mon(720, 1200)],
          },
        }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ status: 'pending_review', submittedAt: new Date() }),
      );

      await service.submit(driver, 'app-1');

      expect(mockPrisma.onboardingApplication.update).toHaveBeenCalled();
    });

    it('rechaza enviar un borrador con horarios solapados (422)', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: {
            name: 'Centro',
            location: georefLocation,
            schedules: [mon(480, 720), mon(600, 900)],
          },
        }),
      );

      const error = await service
        .submit(driver, 'app-1')
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      expect(problem(error).validationsErrors?.[0].field).toBe(
        'declaredEntity.schedules.1',
      );
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    it('rejects submitting an already approved application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'approved' }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.submit(driver, 'app-1')).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    // ── El domicilio es obligatorio para PASAR A REVISIÓN ──────────────────
    //
    // El wizard ya lo exigía en el front, pero por API se podía mandar una
    // solicitud a revisión sin ninguna dirección. La validación va acá y no en
    // el DTO: un BORRADOR incompleto es legítimo, una solicitud en revisión
    // sin domicilio no.

    it('rechaza enviar a revisión una solicitud SIN dirección', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ declaredEntity: { name: 'Centro', cuit: '30123456789' } }),
      );

      const error = await service
        .submit(driver, 'app-1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FormattedExceptionWithValidation);
      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      expect(problem(error).status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('acepta una dirección normalizada por Georef', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: { name: 'Centro', location: georefLocation },
        }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ status: 'pending_review', submittedAt: new Date() }),
      );

      await service.submit(driver, 'app-1');

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { status: string } };
      expect(updateArg.data.status).toBe('pending_review');
    });

    it('acepta los cuatro campos cargados a mano, sin Georef', async () => {
      // Georef caído no puede frenar un alta: la carga manual es un camino de
      // primera, no un plan B degradado.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: { name: 'Centro', location: manualLocation },
        }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(
        ownedApp({ status: 'pending_review', submittedAt: new Date() }),
      );

      await service.submit(driver, 'app-1');

      const updateArg = mockPrisma.onboardingApplication.update.mock
        .calls[0][0] as { data: { status: string } };
      expect(updateArg.data.status).toBe('pending_review');
    });

    it('rechaza una dirección PARCIAL nombrando lo que falta', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: {
            name: 'Centro',
            location: {
              streetName: 'Avenida Corrientes',
              streetNumber: '1234',
              geocodingSource: 'manual' as const,
            },
          },
        }),
      );

      const error = await service
        .submit(driver, 'app-1')
        .catch((e: unknown) => e);

      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      // No es un 400 genérico: dice exactamente qué campos faltan, y los dice
      // también en `validationsErrors` para que el cliente pueda marcarlos.
      expect(problem(error).detail).toContain('cityName and stateName');
      expect(problem(error).validationsErrors?.map((v) => v.field)).toEqual([
        'declaredEntity.location.cityName',
        'declaredEntity.location.stateName',
      ]);
      expect(mockPrisma.onboardingApplication.update).not.toHaveBeenCalled();
    });

    it('rechaza un borrador viejo que sólo tiene el `address` plano', async () => {
      // Decisión consciente: una línea de texto libre NO alcanza, mismo
      // criterio que el front. No sirve para la ubicación del Store de Mercado
      // Pago, que es para lo que se pide la dirección. El error nombra los
      // cuatro campos, así que quien tenga un borrador así ve qué completar.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({
          declaredEntity: { name: 'Centro', address: 'Av. Corrientes 1234' },
        }),
      );

      const error = await service
        .submit(driver, 'app-1')
        .catch((e: unknown) => e);

      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_NOT_SUBMITTABLE);
      expect(problem(error).validationsErrors).toHaveLength(4);
    });

    it('NO revalida las solicitudes que ya están en revisión', async () => {
      // 🔴 La validación es de la TRANSICIÓN, no del recurso. Una solicitud sin
      // dirección que entró a `pending_review` antes de este cambio sigue su
      // curso normal: el chequeo de estado corta primero y devuelve
      // ONBOARDING_INVALID_STATE, no el código nuevo. Si esto se invirtiera,
      // los borradores viejos ya enviados empezarían a fallar con otro error.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ status: 'pending_review', declaredEntity: { name: 'X' } }),
      );

      const error = await service
        .submit(driver, 'app-1')
        .catch((e: unknown) => e);

      expect(problem(error).code).toBe(ErrorCodes.ONBOARDING_INVALID_STATE);
      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
    });

    it('un borrador SIN dirección se puede seguir guardando y editando', async () => {
      // La obligatoriedad no toca `update()`: para eso es un borrador.
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(
        ownedApp({ declaredEntity: { name: 'Centro' } }),
      );
      mockPrisma.onboardingApplication.update.mockResolvedValue(ownedApp());

      await service.update(driver, 'app-1', { name: 'Centro II' });

      expect(mockPrisma.onboardingApplication.update).toHaveBeenCalled();
    });
  });

  describe('addDocument', () => {
    it('registers document metadata for the application', async () => {
      mockPrisma.onboardingApplication.findUnique.mockResolvedValue(ownedApp());
      mockPrisma.applicationDocument.create.mockResolvedValue({
        id: 'doc-1',
        name: 'file.pdf',
        storagePath: 'apps/app-1/file.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const doc = await service.addDocument(driver, 'app-1', {
        name: 'file.pdf',
        storagePath: 'apps/app-1/file.pdf',
      });

      expect(doc.id).toBe('doc-1');
      const createArg = mockPrisma.applicationDocument.create.mock
        .calls[0][0] as { data: { applicationId: string } };
      expect(createArg.data.applicationId).toBe('app-1');
    });
  });
});
