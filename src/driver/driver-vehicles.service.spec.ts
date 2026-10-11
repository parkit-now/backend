import { HttpStatus } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { holdingWhere } from '../reservations/reservation-capacity';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { DriverVehiclesService } from './driver-vehicles.service';

const NOW = new Date('2026-10-03T12:00:00-03:00');
const USER = { id: 'user-1' } as User;
const VEHICLE_ID = '0192f0a0-0000-4000-8000-0000000000a1';

const client = {
  driverVehicle: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  reservation: { findMany: jest.fn() },
  vehicleCatalogDefault: { findMany: jest.fn(), findFirst: jest.fn() },
};

// La transacción corre el callback con el mismo doble: lo que importa es QUÉ
// se escribe, no que Prisma sepa abrir una transacción.
const prisma = {
  ...client,
  $transaction: jest.fn((fn: (tx: typeof client) => unknown) => fn(client)),
};

const service = new DriverVehiclesService(prisma as unknown as PrismaService);

const vehicle = (overrides: object = {}) => ({
  id: VEHICLE_ID,
  userId: USER.id,
  plate: 'AB123CD',
  category: 'car',
  brand: 'Toyota',
  model: 'Etios',
  isPrimary: true,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
});

async function expectFailure(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
) {
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toBeInstanceOf(FormattedException);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await expect(promise).rejects.toMatchObject({
    status,
    response: expect.objectContaining({ code }) as unknown,
  });
}

describe('DriverVehiclesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    client.reservation.findMany.mockResolvedValue([]);
    client.driverVehicle.findFirst.mockResolvedValue(vehicle());
    client.vehicleCatalogDefault.findFirst.mockResolvedValue(null);
  });

  describe('list', () => {
    it('lista los del conductor, el principal primero, y marca los que tienen reserva activa', async () => {
      client.driverVehicle.findMany.mockResolvedValue([
        vehicle(),
        vehicle({
          id: 'v-2',
          plate: 'A123BCD',
          category: 'motorcycle',
          isPrimary: false,
        }),
      ]);
      client.reservation.findMany.mockResolvedValue([
        { vehiclePlate: 'A123BCD' },
      ]);

      const result = await service.list(USER, NOW);

      expect(client.driverVehicle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER.id },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        }),
      );
      expect(client.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER.id,
            ...holdingWhere(NOW),
            exitAt: { gt: NOW },
          },
        }),
      );
      expect(result.map((v) => [v.plate, v.hasActiveReservation])).toEqual([
        ['AB123CD', false],
        ['A123BCD', true],
      ]);
    });
  });

  describe('create', () => {
    const dto = { plate: 'AB123CD', category: 'car' as const };

    it('el primer vehículo es principal aunque no se pida', async () => {
      client.driverVehicle.count.mockResolvedValue(0);
      client.driverVehicle.create.mockResolvedValue(vehicle());

      await service.create(USER, dto, NOW);

      expect(client.driverVehicle.updateMany).toHaveBeenCalledWith({
        where: { userId: USER.id, isPrimary: true },
        data: { isPrimary: false },
      });
      expect(client.driverVehicle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER.id,
          plate: 'AB123CD',
          isPrimary: true,
          brand: null,
          model: null,
        }) as unknown,
      });
    });

    it('uno más no cambia el principal salvo que se pida', async () => {
      client.driverVehicle.count.mockResolvedValue(1);
      client.driverVehicle.create.mockResolvedValue(
        vehicle({ isPrimary: false }),
      );

      await service.create(USER, dto, NOW);

      expect(client.driverVehicle.updateMany).not.toHaveBeenCalled();
      expect(client.driverVehicle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isPrimary: false }) as unknown,
      });
    });

    it('rechaza una patente repetida del mismo conductor', async () => {
      client.driverVehicle.count.mockResolvedValue(1);
      client.driverVehicle.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expectFailure(
        service.create(USER, dto, NOW),
        HttpStatus.CONFLICT,
        'DRIVER_VEHICLE_PLATE_TAKEN',
      );
    });

    it('guarda marca y modelo con la grafía del catálogo', async () => {
      client.driverVehicle.count.mockResolvedValue(1);
      client.driverVehicle.create.mockResolvedValue(vehicle());
      client.vehicleCatalogDefault.findFirst.mockResolvedValue({
        brand: 'Toyota',
        model: 'Etios',
      });

      await service.create(
        USER,
        { ...dto, brand: 'toyota', model: 'ETIOS' },
        NOW,
      );

      expect(client.vehicleCatalogDefault.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            brand: { equals: 'toyota', mode: 'insensitive' },
            model: { equals: 'ETIOS', mode: 'insensitive' },
          },
        }),
      );
      expect(client.driverVehicle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          brand: 'Toyota',
          model: 'Etios',
        }) as unknown,
      });
    });

    it('acepta la marca sola si existe en el catálogo', async () => {
      client.driverVehicle.count.mockResolvedValue(1);
      client.driverVehicle.create.mockResolvedValue(vehicle({ model: null }));
      client.vehicleCatalogDefault.findFirst.mockResolvedValue({
        brand: 'Toyota',
        model: 'Corolla',
      });

      await service.create(USER, { ...dto, brand: 'Toyota' }, NOW);

      expect(client.vehicleCatalogDefault.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { brand: { equals: 'Toyota', mode: 'insensitive' } },
        }),
      );
      expect(client.driverVehicle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          brand: 'Toyota',
          model: null,
        }) as unknown,
      });
    });

    it('rechaza marca o modelo que no están en el catálogo', async () => {
      client.driverVehicle.count.mockResolvedValue(1);
      await expectFailure(
        service.create(USER, { ...dto, brand: 'Pirulo', model: 'X' }, NOW),
        HttpStatus.BAD_REQUEST,
        'DRIVER_VEHICLE_NOT_IN_CATALOG',
      );
      // Un modelo sin marca no se puede ubicar en el catálogo: ni se consulta.
      client.vehicleCatalogDefault.findFirst.mockClear();
      await expectFailure(
        service.create(USER, { ...dto, model: 'Etios' }, NOW),
        HttpStatus.BAD_REQUEST,
        'DRIVER_VEHICLE_NOT_IN_CATALOG',
      );
      expect(client.vehicleCatalogDefault.findFirst).not.toHaveBeenCalled();
      expect(client.driverVehicle.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('edita marca y modelo aunque tenga una reserva activa', async () => {
      client.reservation.findMany.mockResolvedValue([
        { vehiclePlate: 'AB123CD' },
      ]);
      client.driverVehicle.update.mockResolvedValue(
        vehicle({ model: 'Yaris' }),
      );
      client.vehicleCatalogDefault.findFirst.mockResolvedValue({
        brand: 'Toyota',
        model: 'Yaris',
      });

      const result = await service.update(
        USER,
        VEHICLE_ID,
        { model: 'Yaris' },
        NOW,
      );

      expect(result.model).toBe('Yaris');
      expect(client.driverVehicle.update).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID },
        data: { brand: 'Toyota', model: 'Yaris' },
      });
    });

    it('rechaza cambiar a una marca o modelo fuera del catálogo', async () => {
      await expectFailure(
        service.update(USER, VEHICLE_ID, { model: 'Pirulo' }, NOW),
        HttpStatus.BAD_REQUEST,
        'DRIVER_VEHICLE_NOT_IN_CATALOG',
      );
      expect(client.driverVehicle.update).not.toHaveBeenCalled();
    });

    it('un vehículo con texto libre anterior se edita si no cambia marca ni modelo', async () => {
      const legacy = vehicle({ brand: 'Pirulo', model: 'Viejo' });
      client.driverVehicle.findFirst.mockResolvedValue(legacy);
      client.driverVehicle.update.mockResolvedValue(legacy);

      await service.update(
        USER,
        VEHICLE_ID,
        { brand: 'Pirulo', model: 'Viejo', plate: 'AC456DE' },
        NOW,
      );

      expect(client.vehicleCatalogDefault.findFirst).not.toHaveBeenCalled();
      expect(client.driverVehicle.update).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID },
        data: { plate: 'AC456DE' },
      });
    });

    it('quitar marca y modelo no consulta el catálogo', async () => {
      client.driverVehicle.update.mockResolvedValue(
        vehicle({ brand: null, model: null }),
      );

      await service.update(USER, VEHICLE_ID, { brand: null, model: null }, NOW);

      expect(client.vehicleCatalogDefault.findFirst).not.toHaveBeenCalled();
      expect(client.driverVehicle.update).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID },
        data: { brand: null, model: null },
      });
    });

    it('no cambia patente ni categoría con una reserva activa', async () => {
      client.reservation.findMany.mockResolvedValue([
        { vehiclePlate: 'AB123CD' },
      ]);
      await expectFailure(
        service.update(USER, VEHICLE_ID, { plate: 'AC456DE' }, NOW),
        HttpStatus.CONFLICT,
        'DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION',
      );
      await expectFailure(
        service.update(USER, VEHICLE_ID, { category: 'suv' as const }, NOW),
        HttpStatus.CONFLICT,
        'DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION',
      );
      expect(client.driverVehicle.update).not.toHaveBeenCalled();
    });

    it('marcar como principal desmarca al anterior; desmarcar no se acepta', async () => {
      client.driverVehicle.findFirst.mockResolvedValue(
        vehicle({ isPrimary: false }),
      );
      client.driverVehicle.update.mockResolvedValue(vehicle());

      await service.update(USER, VEHICLE_ID, { isPrimary: true }, NOW);
      expect(client.driverVehicle.updateMany).toHaveBeenCalledWith({
        where: { userId: USER.id, isPrimary: true },
        data: { isPrimary: false },
      });

      await expectFailure(
        service.update(USER, VEHICLE_ID, { isPrimary: false }, NOW),
        HttpStatus.BAD_REQUEST,
        'DRIVER_VEHICLE_PRIMARY_REQUIRED',
      );
    });

    it('404 si el vehículo no es del conductor', async () => {
      client.driverVehicle.findFirst.mockResolvedValue(null);
      await expectFailure(
        service.update(USER, VEHICLE_ID, { model: 'X' }, NOW),
        HttpStatus.NOT_FOUND,
        'DRIVER_VEHICLE_NOT_FOUND',
      );
      expect(client.driverVehicle.findFirst).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID, userId: USER.id },
      });
    });
  });

  describe('remove', () => {
    it('al borrar el principal promueve al más antiguo', async () => {
      client.driverVehicle.findFirst
        .mockResolvedValueOnce(vehicle())
        .mockResolvedValueOnce(vehicle({ id: 'v-2', isPrimary: false }));

      await service.remove(USER, VEHICLE_ID, NOW);

      expect(client.driverVehicle.delete).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID },
      });
      expect(client.driverVehicle.update).toHaveBeenCalledWith({
        where: { id: 'v-2' },
        data: { isPrimary: true },
      });
    });

    it('no borra un vehículo con reserva activa', async () => {
      client.reservation.findMany.mockResolvedValue([
        { vehiclePlate: 'AB123CD' },
      ]);
      await expectFailure(
        service.remove(USER, VEHICLE_ID, NOW),
        HttpStatus.CONFLICT,
        'DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION',
      );
      expect(client.driverVehicle.delete).not.toHaveBeenCalled();
    });
  });

  it('findOwnedCategory busca por conductor y patente y devuelve el tipo', async () => {
    client.driverVehicle.findUnique.mockResolvedValue({
      category: 'motorcycle',
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(service.findOwnedCategory(USER, 'AB123CD')).resolves.toBe(
      'motorcycle',
    );
    expect(client.driverVehicle.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_plate: { userId: USER.id, plate: 'AB123CD' } },
      }),
    );
  });

  it('findOwnedCategory devuelve null si la patente no es del conductor', async () => {
    client.driverVehicle.findUnique.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      service.findOwnedCategory(USER, 'ZZ999ZZ'),
    ).resolves.toBeNull();
  });

  describe('listCatalog', () => {
    it('devuelve marca, modelo y categoría ordenados por marca y modelo', async () => {
      client.vehicleCatalogDefault.findMany.mockResolvedValue([
        { brand: 'Toyota', model: 'Hilux', category: 'pickup' },
        { brand: 'Renault', model: 'Kangoo', category: 'van' },
        // Una categoría fuera de la lista (no debería pasar) no se publica.
        { brand: 'X', model: 'Y', category: 'monopatin' },
      ]);

      const result = await service.listCatalog();

      expect(client.vehicleCatalogDefault.findMany).toHaveBeenCalledWith({
        orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      });
      expect(result).toEqual([
        { brand: 'Toyota', model: 'Hilux', category: 'pickup' },
        { brand: 'Renault', model: 'Kangoo', category: 'van' },
      ]);
    });
  });
});
