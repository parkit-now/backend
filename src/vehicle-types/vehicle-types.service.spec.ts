import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, VehicleType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { VehicleTypesService } from './vehicle-types.service';

const TENANT = 'tenant-1';
const TYPE = '00000000-0000-4000-8000-00000000000a';
const TARGET = '00000000-0000-4000-8000-00000000000b';

/**
 * `FormattedException` mete title/status/detail/instance/code en el BODY de la
 * HttpException, no como propiedades de la instancia.
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

describe('VehicleTypesService', () => {
  let service: VehicleTypesService;

  const tx = {
    vehicleType: { findFirst: jest.fn(), updateMany: jest.fn() },
    vehicle: { count: jest.fn(), updateMany: jest.fn() },
  };

  const mockTenant = {
    vehicleType: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    vehicle: { groupBy: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockPrisma = { getTenantClient: jest.fn().mockReturnValue(mockTenant) };
  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue(TENANT),
  };

  const makeType = (overrides: Partial<VehicleType> = {}): VehicleType => ({
    id: TYPE,
    tenantId: TENANT,
    name: 'Utilitario',
    accepted: true,
    version: 1,
    syncSeq: 5,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.getTenantClient.mockReturnValue(mockTenant);
    mockTenantContext.getTenantIdOrThrow.mockReturnValue(TENANT);
    // Corre el callback con el `tx` mockeado, como haría Prisma.
    mockTenant.$transaction.mockImplementation(
      (cb: (t: typeof tx) => unknown) => cb(tx),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VehicleTypesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<VehicleTypesService>(VehicleTypesService);
  });

  describe('listVehicleTypes', () => {
    it('adjunta el conteo de vehículos por tipo', async () => {
      mockTenant.vehicleType.findMany.mockResolvedValue([
        makeType(),
        makeType({ id: TARGET, name: 'Otro' }),
      ]);
      mockTenant.vehicle.groupBy.mockResolvedValue([
        { typeId: TYPE, _count: { _all: 3 } },
      ]);

      const result = await service.listVehicleTypes();

      expect(result[0]).toMatchObject({ name: 'Utilitario', vehicleCount: 3 });
      // Un tipo sin vehículos tiene que dar 0, no undefined: el modal decide
      // con este número si pide destino de reasignación.
      expect(result[1]).toMatchObject({ name: 'Otro', vehicleCount: 0 });
    });

    it('excluye las bajas lógicas del listado del ABM', async () => {
      mockTenant.vehicleType.findMany.mockResolvedValue([]);
      mockTenant.vehicle.groupBy.mockResolvedValue([]);

      await service.listVehicleTypes();

      expect(mockTenant.vehicleType.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: [{ name: 'asc' }],
      });
    });
  });

  describe('pullChanges', () => {
    it('NO filtra deletedAt: el tombstone es cómo viaja una baja', async () => {
      mockTenant.vehicleType.findMany.mockResolvedValue([
        makeType({
          deletedAt: new Date('2026-03-01T00:00:00.000Z'),
          syncSeq: 20,
        }),
      ]);

      const result = await service.pullChanges({ afterSeq: 1, limit: 1000 });

      expect(mockTenant.vehicleType.findMany).toHaveBeenCalledWith({
        where: { syncSeq: { gt: 1 } },
        orderBy: { syncSeq: 'asc' },
        take: 1000,
      });
      expect(result.items[0].deletedAt).toBe('2026-03-01T00:00:00.000Z');
      expect(result.maxSeq).toBe(20);
    });

    it('con página vacía devuelve el mismo afterSeq, sin retroceder', async () => {
      mockTenant.vehicleType.findMany.mockResolvedValue([]);
      const result = await service.pullChanges({ afterSeq: 77, limit: 1000 });
      expect(result.maxSeq).toBe(77);
    });
  });

  describe('createVehicleType', () => {
    it('crea con el tenant del contexto y accepted por defecto en true', async () => {
      mockTenant.vehicleType.create.mockResolvedValue(makeType());

      await service.createVehicleType({ id: TYPE, name: 'Utilitario' });

      expect(mockTenant.vehicleType.create).toHaveBeenCalledWith({
        data: {
          id: TYPE,
          name: 'Utilitario',
          accepted: true,
          tenantId: TENANT,
        },
      });
    });

    it('nombre repetido (P2002) -> 409 VEHICLE_TYPE_DUPLICATE', async () => {
      mockTenant.vehicleType.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      );

      const error = await service
        .createVehicleType({ id: TYPE, name: 'Utilitario' })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_TYPE_DUPLICATE);
    });
  });

  describe('updateVehicleType', () => {
    it('bumpea version en la app: el trigger de esta tabla no la pisa', async () => {
      mockTenant.vehicleType.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.vehicleType.findUniqueOrThrow.mockResolvedValue(
        makeType({ version: 2 }),
      );

      await service.updateVehicleType(TYPE, 1, { accepted: false });

      expect(mockTenant.vehicleType.updateMany).toHaveBeenCalledWith({
        where: { id: TYPE, tenantId: TENANT, version: 1, deletedAt: null },
        data: { version: { increment: 1 }, accepted: false },
      });
    });

    it('version vieja -> 409 CONFLICT', async () => {
      mockTenant.vehicleType.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.vehicleType.findFirst.mockResolvedValue(
        makeType({ version: 9 }),
      );

      const error = await service
        .updateVehicleType(TYPE, 1, { accepted: false })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).code).toBe(ErrorCodes.CONFLICT);
    });

    it('fila inexistente (o de otro tenant) -> 404', async () => {
      mockTenant.vehicleType.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.vehicleType.findFirst.mockResolvedValue(null);

      const error = await service
        .updateVehicleType(TYPE, 1, { accepted: false })
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.NOT_FOUND);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_TYPE_NOT_FOUND);
    });
  });

  describe('deleteVehicleType', () => {
    it('sin vehículos: borra y no reasigna nada', async () => {
      tx.vehicleType.updateMany.mockResolvedValue({ count: 1 });
      tx.vehicle.count.mockResolvedValue(0);

      const result = await service.deleteVehicleType(TYPE, 1);

      expect(result).toEqual({
        reassignedVehicles: 0,
        reassignedToTypeId: null,
      });
      expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('en uso y sin destino -> 409 VEHICLE_TYPE_IN_USE (revierte el borrado)', async () => {
      tx.vehicleType.updateMany.mockResolvedValue({ count: 1 });
      tx.vehicle.count.mockResolvedValue(4);

      const error = await service
        .deleteVehicleType(TYPE, 1)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).code).toBe(ErrorCodes.VEHICLE_TYPE_IN_USE);
      expect(problem(error).detail).toContain('4 vehicle(s)');
      // El throw es lo que revierte: no se llegó a reasignar nada.
      expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('reasigna los N vehículos y los reporta', async () => {
      tx.vehicleType.findFirst.mockResolvedValue({ id: TARGET });
      tx.vehicleType.updateMany.mockResolvedValue({ count: 1 });
      tx.vehicle.count.mockResolvedValue(7);
      tx.vehicle.updateMany.mockResolvedValue({ count: 7 });

      const result = await service.deleteVehicleType(TYPE, 1, TARGET);

      expect(tx.vehicle.updateMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT, typeId: TYPE, deletedAt: null },
        data: { typeId: TARGET },
      });
      expect(result).toEqual({
        reassignedVehicles: 7,
        reassignedToTypeId: TARGET,
      });
    });

    it('destino igual al origen -> 400, sin tocar la base', async () => {
      const error = await service
        .deleteVehicleType(TYPE, 1, TYPE)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.BAD_REQUEST);
      expect(problem(error).code).toBe(
        ErrorCodes.VEHICLE_TYPE_REASSIGN_TARGET_INVALID,
      );
      expect(tx.vehicleType.updateMany).not.toHaveBeenCalled();
    });

    it('destino inexistente o de otro tenant -> 400 indistinguible (anti-IDOR)', async () => {
      tx.vehicleType.findFirst.mockResolvedValue(null);

      const error = await service
        .deleteVehicleType(TYPE, 1, TARGET)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.BAD_REQUEST);
      expect(problem(error).code).toBe(
        ErrorCodes.VEHICLE_TYPE_REASSIGN_TARGET_INVALID,
      );
      // El filtro por tenantId es lo que hace indistinguibles los dos casos.
      expect(tx.vehicleType.findFirst).toHaveBeenCalledWith({
        where: { id: TARGET, tenantId: TENANT, deletedAt: null },
        select: { id: true },
      });
      expect(tx.vehicleType.updateMany).not.toHaveBeenCalled();
    });

    it('el CAS va PRIMERO: si falla, no se escriben N filas de vehicles', async () => {
      tx.vehicleType.findFirst
        .mockResolvedValueOnce({ id: TARGET }) // validación del destino
        .mockResolvedValueOnce(makeType({ version: 9 })); // diagnóstico
      tx.vehicleType.updateMany.mockResolvedValue({ count: 0 });

      const error = await service
        .deleteVehicleType(TYPE, 1, TARGET)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(tx.vehicle.count).not.toHaveBeenCalled();
      expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('un segundo DELETE avisa que ya estaba borrado', async () => {
      tx.vehicleType.updateMany.mockResolvedValue({ count: 0 });
      tx.vehicleType.findFirst.mockResolvedValue(
        makeType({ deletedAt: new Date() }),
      );

      const error = await service
        .deleteVehicleType(TYPE, 1)
        .catch((e: unknown) => e);

      expect(problem(error).status).toBe(HttpStatus.CONFLICT);
      expect(problem(error).detail).toContain('already deleted');
    });
  });
});
