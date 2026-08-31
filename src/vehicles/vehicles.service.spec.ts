import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { VehicleScope } from './dto/list-vehicles-query.dto';
import { VehiclesService } from './vehicles.service';

describe('VehiclesService', () => {
  let service: VehiclesService;

  const mockPrisma = {
    vehicle: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    // Presente a propósito: los tests asertan que NO se usa. `Vehicle` está
    // fuera de TENANT_MODELS y el cliente tenant ocultaría los globales.
    getTenantClient: jest.fn(),
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  const makeVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
    id: 'v-1',
    brand: 'Toyota',
    model: 'Corolla',
    type: 'auto',
    tenantId: 'tenant-1',
    version: 1,
    syncSeq: 1,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const p2002 = (): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  /**
   * Lee el argumento de la N-ésima llamada de un mock, tipado. Sin esto, el
   * acceso a `.mock.calls[0][0].where` es `any` y ESLint lo rechaza.
   */
  const argOf = <T>(mock: { mock: { calls: unknown[][] } }, call = 0): T =>
    mock.mock.calls[call][0] as T;

  /** Ejecuta `fn` y devuelve la FormattedException que tiró. */
  const catchFormatted = async (
    fn: () => Promise<unknown>,
  ): Promise<FormattedException> => {
    try {
      await fn();
    } catch (error) {
      expect(error).toBeInstanceOf(FormattedException);
      return error as FormattedException;
    }
    throw new Error('Expected the call to throw, but it resolved.');
  };

  const bodyOf = (
    error: FormattedException,
  ): { status: number; code: string } =>
    error.getResponse() as { status: number; code: string };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenantContext.getTenantIdOrThrow.mockReturnValue('tenant-1');
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehiclesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<VehiclesService>(VehiclesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listVehicles', () => {
    it('devuelve los globales y los del estacionamiento, sin bajas', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([makeVehicle()]);

      await service.listVehicles({ scope: VehicleScope.all });

      expect(mockPrisma.vehicle.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ tenantId: null }, { tenantId: 'tenant-1' }],
          deletedAt: null,
        },
        orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      });
    });

    it('excluye las bajas lógicas: es vista de usuario, no feed de sync', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      await service.listVehicles({ scope: VehicleScope.all });

      const { where } = argOf<{ where: { deletedAt: null } }>(
        mockPrisma.vehicle.findMany,
      );
      expect(where.deletedAt).toBeNull();
    });

    it('scope=tenant deja fuera los globales', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      await service.listVehicles({ scope: VehicleScope.tenant });

      expect(mockPrisma.vehicle.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', deletedAt: null },
        orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      });
    });

    it('scope=global deja fuera los propios', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      await service.listVehicles({ scope: VehicleScope.global });

      expect(mockPrisma.vehicle.findMany).toHaveBeenCalledWith({
        where: { tenantId: null, deletedAt: null },
        orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      });
    });

    it('expone `version` para que el cliente pueda hacer optimistic locking', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([
        makeVehicle({ version: 7 }),
      ]);

      const [row] = await service.listVehicles({ scope: VehicleScope.all });

      expect(row.version).toBe(7);
    });

    it('NO usa el cliente tenant, que ocultaría los globales', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      await service.listVehicles({ scope: VehicleScope.all });

      expect(mockPrisma.getTenantClient).not.toHaveBeenCalled();
    });
  });

  describe('pullCatalogChanges', () => {
    it('NO filtra deletedAt: el tombstone es la única señal de baja offline', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      await service.pullCatalogChanges({ afterSeq: 0, limit: 1000 });

      const { where } = argOf<{ where: Record<string, unknown> }>(
        mockPrisma.vehicle.findMany,
      );
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('devuelve el syncSeq del último item como maxSeq', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([
        makeVehicle({ syncSeq: 5 }),
        makeVehicle({ id: 'v-2', syncSeq: 9 }),
      ]);

      const result = await service.pullCatalogChanges({
        afterSeq: 1,
        limit: 1000,
      });

      expect(result.maxSeq).toBe(9);
      expect(result.items).toHaveLength(2);
    });

    it('con página vacía hace echo de afterSeq, para no retroceder el cursor', async () => {
      mockPrisma.vehicle.findMany.mockResolvedValue([]);

      const result = await service.pullCatalogChanges({
        afterSeq: 42,
        limit: 1000,
      });

      expect(result.maxSeq).toBe(42);
    });

    it('propaga el deletedAt del tombstone al DTO', async () => {
      const deletedAt = new Date('2026-05-04T18:00:00.000Z');
      mockPrisma.vehicle.findMany.mockResolvedValue([
        makeVehicle({ deletedAt }),
      ]);

      const result = await service.pullCatalogChanges({
        afterSeq: 0,
        limit: 1000,
      });

      expect(result.items[0].deletedAt).toBe(deletedAt.toISOString());
    });
  });

  describe('createTenantVehicle', () => {
    const dto = { id: 'v-new', brand: 'Fiat', model: 'Cronos' };

    it('fuerza el tenantId del contexto: no se pueden crear globales por HTTP', async () => {
      mockPrisma.vehicle.create.mockResolvedValue(makeVehicle());

      await service.createTenantVehicle(dto);

      const { data } = argOf<{ data: { tenantId: string } }>(
        mockPrisma.vehicle.create,
      );
      expect(data.tenantId).toBe('tenant-1');
    });

    it('rechaza con VEHICLE_ALREADY_IN_GLOBAL_CATALOG si ya existe como global', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'g-1', tenant_id: null }]);

      const error = await catchFormatted(() =>
        service.createTenantVehicle(dto),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.CONFLICT);
      expect(bodyOf(error).code).toBe(
        ErrorCodes.VEHICLE_ALREADY_IN_GLOBAL_CATALOG,
      );
      expect(mockPrisma.vehicle.create).not.toHaveBeenCalled();
    });

    it('rechaza con VEHICLE_DUPLICATE si ya existe uno propio igual', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'v-9', tenant_id: 'tenant-1' },
      ]);

      const error = await catchFormatted(() =>
        service.createTenantVehicle(dto),
      );

      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_DUPLICATE);
      expect(mockPrisma.vehicle.create).not.toHaveBeenCalled();
    });

    it('mapea el P2002 de la carrera a un 409 con code propio', async () => {
      mockPrisma.vehicle.create.mockRejectedValue(p2002());

      const error = await catchFormatted(() =>
        service.createTenantVehicle(dto),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.CONFLICT);
      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_DUPLICATE);
    });
  });

  describe('updateTenantVehicle', () => {
    const dto = { model: 'Cronos Drive' };

    it('hace un compare-and-swap atómico contra la versión esperada', async () => {
      mockPrisma.vehicle.findUnique.mockResolvedValue(makeVehicle());
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.vehicle.findUniqueOrThrow.mockResolvedValue(makeVehicle());

      await service.updateTenantVehicle('v-1', 3, dto);

      expect(mockPrisma.vehicle.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'v-1',
            tenantId: 'tenant-1',
            version: 3,
            deletedAt: null,
          },
        }),
      );
    });

    it('nunca usa vehicle.update: el read-then-write tenía una carrera', async () => {
      mockPrisma.vehicle.findUnique.mockResolvedValue(makeVehicle());
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.vehicle.findUniqueOrThrow.mockResolvedValue(makeVehicle());

      await service.updateTenantVehicle('v-1', 1, dto);

      expect(mockPrisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('404 VEHICLE_NOT_FOUND cuando la fila no existe', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(null);

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { type: 'auto' }),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.NOT_FOUND);
      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_NOT_FOUND);
    });

    it('404 VEHICLE_NOT_OWNED_BY_TENANT cuando la fila es global', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ tenantId: null }),
      );

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { type: 'auto' }),
      );

      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_NOT_OWNED_BY_TENANT);
    });

    it('una fila de OTRO estacionamiento se ve igual que "no existe" (sin oráculo IDOR)', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ tenantId: 'tenant-2' }),
      );

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { type: 'auto' }),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.NOT_FOUND);
      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_NOT_FOUND);
    });

    it('409 CONFLICT cuando la fila ya estaba borrada', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ deletedAt: new Date() }),
      );

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { type: 'auto' }),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.CONFLICT);
      expect(bodyOf(error).code).toBe(ErrorCodes.CONFLICT);
    });

    it('409 CONFLICT cuando la versión quedó vieja', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ version: 5 }),
      );

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { type: 'auto' }),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.CONFLICT);
      expect(bodyOf(error).code).toBe(ErrorCodes.CONFLICT);
    });

    it('también valida duplicados al renombrar, no solo al crear', async () => {
      mockPrisma.vehicle.findUnique.mockResolvedValue(makeVehicle());
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'otro', tenant_id: 'tenant-1' },
      ]);

      const error = await catchFormatted(() =>
        service.updateTenantVehicle('v-1', 1, { brand: 'Fiat', model: 'Uno' }),
      );

      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_DUPLICATE);
      expect(mockPrisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('no se choca consigo mismo al guardar sin cambiar marca ni modelo', async () => {
      mockPrisma.vehicle.findUnique.mockResolvedValue(makeVehicle());
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'v-1', tenant_id: 'tenant-1' },
      ]);
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.vehicle.findUniqueOrThrow.mockResolvedValue(makeVehicle());

      const updated = await service.updateTenantVehicle('v-1', 1, {
        brand: 'Toyota',
      });
      expect(updated).toBeDefined();
    });
  });

  describe('deleteTenantVehicle', () => {
    it('estampa deletedAt vía updateMany, nunca borra la fila', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 1 });

      await service.deleteTenantVehicle('v-1', 2);

      expect(mockPrisma.vehicle.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'v-1',
            tenantId: 'tenant-1',
            version: 2,
            deletedAt: null,
          },
        }),
      );
      expect(mockPrisma.vehicle.delete).not.toHaveBeenCalled();
      expect(mockPrisma.vehicle.deleteMany).not.toHaveBeenCalled();
    });

    it('el segundo DELETE da 409 en vez de re-emitir el tombstone', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ deletedAt: new Date(), version: 2 }),
      );

      const error = await catchFormatted(() =>
        service.deleteTenantVehicle('v-1', 2),
      );

      expect(bodyOf(error).status).toBe(HttpStatus.CONFLICT);
      // Una sola llamada: la del CAS que no matcheó. Si el guard `deletedAt:
      // null` faltara, este delete habría vuelto a estampar la marca y bumpeado
      // sync_seq, mandando un tombstone repetido a todos los clientes.
      expect(mockPrisma.vehicle.updateMany).toHaveBeenCalledTimes(1);
    });

    it('un global no se puede borrar', async () => {
      mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.vehicle.findUnique.mockResolvedValue(
        makeVehicle({ tenantId: null }),
      );

      const error = await catchFormatted(() =>
        service.deleteTenantVehicle('v-1', 1),
      );

      expect(bodyOf(error).code).toBe(ErrorCodes.VEHICLE_NOT_OWNED_BY_TENANT);
    });
  });
});
