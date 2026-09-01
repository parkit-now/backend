import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { VehiclesService } from './vehicles.service';

/**
 * `FormattedException` mete title/status/detail/instance/code en el BODY de la
 * HttpException, no como propiedades de la instancia. Sin esto las aserciones
 * comparan contra `undefined` y pasan por accidente.
 */
function problem(error: unknown): {
  status: number;
  code: string;
  detail: string;
} {
  return (error as FormattedException).getResponse() as {
    status: number;
    code: string;
    detail: string;
  };
}

const TENANT = 'tenant-1';
const TYPE_ID = '00000000-0000-4000-8000-0000000000aa';

describe('VehiclesService', () => {
  let service: VehiclesService;

  const mockTenant = {
    vehicle: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    vehicleType: {
      findFirst: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
    // Presente a propósito: si alguien vuelve a usar el cliente base para
    // `vehicle`, el aislamiento por tenant se pierde en silencio. Los tests
    // asertan que NO se lo toca.
    vehicle: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue(TENANT),
  };

  const makeVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
    id: 'v-1',
    brand: 'Toyota',
    model: 'Corolla',
    typeId: TYPE_ID,
    tenantId: TENANT,
    version: 1,
    syncSeq: 10,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.getTenantClient.mockReturnValue(mockTenant);
    mockTenantContext.getTenantIdOrThrow.mockReturnValue(TENANT);
    mockTenant.vehicleType.findFirst.mockResolvedValue({ id: TYPE_ID });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehiclesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<VehiclesService>(VehiclesService);
  });

  describe('listVehicles', () => {
    it('usa el cliente tenant y excluye las bajas lógicas', async () => {
      mockTenant.vehicle.findMany.mockResolvedValue([makeVehicle()]);

      const result = await service.listVehicles();

      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.vehicle.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'v-1',
        typeId: TYPE_ID,
        tenantId: TENANT,
      });
    });

    it('NO toca el cliente base: el scoping por tenant se perdería', async () => {
      mockTenant.vehicle.findMany.mockResolvedValue([]);

      await service.listVehicles();

      expect(mockPrisma.vehicle.findMany).not.toHaveBeenCalled();
    });
  });

  describe('pullChanges', () => {
    it('NO filtra deletedAt: los tombstones son cómo viaja una baja', async () => {
      mockTenant.vehicle.findMany.mockResolvedValue([
        makeVehicle({
          deletedAt: new Date('2026-02-01T00:00:00.000Z'),
          syncSeq: 42,
        }),
      ]);

      const result = await service.pullChanges({ afterSeq: 5, limit: 1000 });

      expect(mockTenant.vehicle.findMany).toHaveBeenCalledWith({
        where: { syncSeq: { gt: 5 } },
        orderBy: { syncSeq: 'asc' },
        take: 1000,
      });
      expect(result.items[0].deletedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(result.maxSeq).toBe(42);
    });

    it('con página vacía devuelve el mismo afterSeq, sin retroceder', async () => {
      mockTenant.vehicle.findMany.mockResolvedValue([]);

      const result = await service.pullChanges({ afterSeq: 99, limit: 1000 });

      expect(result.items).toEqual([]);
      expect(result.maxSeq).toBe(99);
    });
  });

  describe('createTenantVehicle', () => {
    it('crea con el tenant del contexto', async () => {
      mockTenant.vehicle.create.mockResolvedValue(makeVehicle());

      await service.createTenantVehicle({
        id: 'v-1',
        brand: 'Toyota',
        model: 'Corolla',
        typeId: TYPE_ID,
      });

      expect(mockTenant.vehicle.create).toHaveBeenCalledWith({
        data: {
          id: 'v-1',
          brand: 'Toyota',
          model: 'Corolla',
          typeId: TYPE_ID,
          tenantId: TENANT,
        },
      });
    });

    it('rechaza un typeId que no existe en este estacionamiento', async () => {
      mockTenant.vehicleType.findFirst.mockResolvedValue(null);

      const error = await service
        .createTenantVehicle({
          id: 'v-1',
          brand: 'Toyota',
          model: 'Corolla',
          typeId: 'no-existe',
        })
        .catch((e: unknown) => e);
      expect(problem(error).status).toBe(HttpStatus.NOT_FOUND);

      expect(mockTenant.vehicle.create).not.toHaveBeenCalled();
    });

    it('el typeId de otro tenant es indistinguible de inexistente (anti-IDOR)', async () => {
      // El cliente tenant inyecta el WHERE tenantId, así que la fila ajena
      // vuelve null sin ningún chequeo explícito.
      mockTenant.vehicleType.findFirst.mockResolvedValue(null);

      const error = await service
        .createTenantVehicle({
          id: 'v-1',
          brand: 'Toyota',
          model: 'Corolla',
          typeId: 'tipo-de-otro-tenant',
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FormattedException);
      expect(problem(error).status).toBe(HttpStatus.NOT_FOUND);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_TYPE_NOT_FOUND);
    });

    it('mapea el P2002 del índice único a VEHICLE_DUPLICATE', async () => {
      mockTenant.vehicle.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      );

      const error = await service
        .createTenantVehicle({
          id: 'v-1',
          brand: 'Toyota',
          model: 'Corolla',
          typeId: TYPE_ID,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FormattedException);
      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_DUPLICATE);
    });
  });

  describe('updateTenantVehicle', () => {
    it('hace compare-and-swap con tenantId, version y deletedAt en el WHERE', async () => {
      mockTenant.vehicle.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.vehicle.findUniqueOrThrow.mockResolvedValue(
        makeVehicle({ version: 2 }),
      );

      await service.updateTenantVehicle('v-1', 1, { brand: 'Toyota' });

      expect(mockTenant.vehicle.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'v-1',
          tenantId: TENANT,
          version: 1,
          deletedAt: null,
        },
        data: { version: { increment: 1 }, brand: 'Toyota' },
      });
    });

    it('valida el typeId nuevo antes de escribir', async () => {
      mockTenant.vehicleType.findFirst.mockResolvedValue(null);

      const error = await service
        .updateTenantVehicle('v-1', 1, { typeId: 'no-existe' })
        .catch((e: unknown) => e);
      expect(problem(error).status).toBe(HttpStatus.NOT_FOUND);

      expect(mockTenant.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('version vieja -> 409 CONFLICT', async () => {
      mockTenant.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.vehicle.findFirst.mockResolvedValue(
        makeVehicle({ version: 7 }),
      );

      const error = await service
        .updateTenantVehicle('v-1', 1, { brand: 'Toyota' })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).code).toBe(ErrorCodes.CONFLICT);
    });

    it('fila inexistente (o de otro tenant) -> 404 VEHICLE_NOT_FOUND', async () => {
      mockTenant.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.vehicle.findFirst.mockResolvedValue(null);

      const error = await service
        .updateTenantVehicle('v-1', 1, { brand: 'Toyota' })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.NOT_FOUND);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_NOT_FOUND);
      // El diagnóstico también va por el cliente tenant: si fuera por el base,
      // la fila de otro estacionamiento se encontraría y filtraría existencia.
      expect(mockPrisma.vehicle.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('deleteTenantVehicle', () => {
    it('es borrado LÓGICO: estampa deletedAt, no saca la fila', async () => {
      mockTenant.vehicle.updateMany.mockResolvedValue({ count: 1 });

      await service.deleteTenantVehicle('v-1', 3);

      const call = mockTenant.vehicle.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: { deletedAt: Date; version: unknown };
      };
      expect(call.where).toEqual({
        id: 'v-1',
        tenantId: TENANT,
        version: 3,
        deletedAt: null,
      });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it('un segundo DELETE da 409 en vez de re-emitir el tombstone', async () => {
      mockTenant.vehicle.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.vehicle.findFirst.mockResolvedValue(
        makeVehicle({ deletedAt: new Date() }),
      );

      const error = await service
        .deleteTenantVehicle('v-1', 3)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).detail).toContain('already deleted');
    });
  });
});
