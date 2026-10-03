import { HttpStatus } from '@nestjs/common';
import { Prisma, ReservationStatus, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { DriverReservationsService } from './driver-reservations.service';
import { DriverService } from './driver.service';
import { DriverReservationStateDto } from './dto/reservation.dto';

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');
const USER = { id: 'user-1' } as User;
const PARKING = '11111111-1111-4111-8111-111111111111';
const RES_ID = '0192f0a0-0000-7000-8000-00000000abcd';

const tx = {
  $executeRaw: jest.fn(),
  reservation: { findMany: jest.fn(), create: jest.fn() },
};

const prisma = {
  reservation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
};

const driverService = { quoteForReservation: jest.fn() };

const service = new DriverReservationsService(
  prisma as unknown as PrismaService,
  driverService as unknown as DriverService,
);

const input = {
  id: RES_ID,
  parkingId: PARKING,
  vehiclePlate: 'AB123CD',
  entryAt: ar('2026-09-28T10:00:00').toISOString(),
  exitAt: ar('2026-09-28T12:00:00').toISOString(),
};

const baseRow = () => ({
  id: RES_ID,
  tenantId: PARKING,
  userId: USER.id,
  vehiclePlate: 'AB123CD',
  entryAt: ar('2026-09-28T10:00:00'),
  exitAt: ar('2026-09-28T12:00:00'),
  totalArs: new Prisma.Decimal(9000),
  rateSnapshotName: 'RESERVAS',
  rateSnapshotHourPriceArs: new Prisma.Decimal(4500),
  status: ReservationStatus.confirmed as ReservationStatus,
  cancelledAt: null as Date | null,
  createdAt: NOW,
  updatedAt: NOW,
  tenant: {
    name: 'Estacionamiento Once',
    address: 'BARTOLOME MITRE 2500',
    latitude: new Prisma.Decimal(-34.6086),
    longitude: new Prisma.Decimal(-58.4019),
  },
});

const row = (overrides: Partial<ReturnType<typeof baseRow>> = {}) => ({
  ...baseRow(),
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

describe('DriverReservationsService', () => {
  const quoted = (entryAt: string, exitAt: string, reservableSpots = 3) => ({
    quote: {
      entryAt,
      exitAt,
      totalArs: 9000,
      rate: { name: 'RESERVAS', hourPriceArs: 4500 },
    },
    reservableSpots,
  });
  const window = (from: string, to: string) => ({
    entryAt: ar(`2026-09-28T${from}:00`),
    exitAt: ar(`2026-09-28T${to}:00`),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.reservation.findUnique.mockResolvedValue(null);
    driverService.quoteForReservation.mockResolvedValue(
      quoted(input.entryAt, input.exitAt),
    );
    tx.reservation.findMany.mockResolvedValue([window('09:00', '11:00')]);
    tx.reservation.create.mockResolvedValue(row());
  });

  describe('create', () => {
    it('recotiza en el servidor y guarda los snapshots', async () => {
      const result = await service.create(USER, input, NOW);

      expect(driverService.quoteForReservation).toHaveBeenCalledWith(
        PARKING,
        { entryAt: input.entryAt, exitAt: input.exitAt },
        NOW,
      );
      const [args] = tx.reservation.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).toMatchObject({
        id: RES_ID,
        tenantId: PARKING,
        userId: USER.id,
        vehiclePlate: 'AB123CD',
        totalArs: 9000,
        rateSnapshotName: 'RESERVAS',
      });
      expect(args.data).not.toHaveProperty('vehicleKind');
      expect(result).toMatchObject({
        state: DriverReservationStateDto.active,
        cancellable: true,
        totalArs: 9000,
        code: 'R-00ABCD',
      });
    });

    it('rechaza cuando el pico de reservas simultáneas llena el cupo', async () => {
      tx.reservation.findMany.mockResolvedValue([
        window('09:00', '11:00'),
        window('10:30', '12:00'),
        window('11:00', '13:00'),
      ]);
      // Nunca hay más de dos a la vez (a las 11 una sale y la otra entra):
      // pico 2 < 3, entra.
      await service.create(USER, input, NOW);
      expect(tx.reservation.create).toHaveBeenCalled();

      tx.reservation.create.mockClear();
      driverService.quoteForReservation.mockResolvedValue(
        quoted(input.entryAt, input.exitAt, 2),
      );
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NO_CAPACITY',
      );
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('reservas que tocan la ventana sin coincidir ocupan una sola plaza', async () => {
      tx.reservation.findMany.mockResolvedValue([
        window('10:00', '10:30'),
        window('11:30', '12:00'),
      ]);
      driverService.quoteForReservation.mockResolvedValue(
        quoted(input.entryAt, input.exitAt, 2),
      );
      await service.create(USER, input, NOW);
      expect(tx.reservation.create).toHaveBeenCalled();
    });

    it('es idempotente: el mismo id devuelve la reserva existente', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row());
      const result = await service.create(USER, input, NOW);
      expect(result.id).toBe(RES_ID);
      expect(driverService.quoteForReservation).not.toHaveBeenCalled();
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('rechaza un id ya usado por otro conductor', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row({ userId: 'otro' }));
      await expectFailure(
        service.create(USER, input, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_ID_CONFLICT',
      );
    });
  });

  describe('list y cancel', () => {
    it('lista sólo las del conductor y deriva el estado', async () => {
      prisma.reservation.findMany.mockResolvedValue([
        row(),
        row({ id: 'b', exitAt: ar('2026-09-26T12:00:00') }),
        row({ id: 'c', status: ReservationStatus.cancelled, cancelledAt: NOW }),
      ]);
      const result = await service.list(USER, NOW);
      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER.id } }),
      );
      expect(result.map((r) => r.state)).toEqual([
        DriverReservationStateDto.active,
        DriverReservationStateDto.completed,
        DriverReservationStateDto.cancelled,
      ]);
    });

    it('cancela una reserva propia que no empezó', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row());
      prisma.reservation.update.mockResolvedValue(
        row({ status: ReservationStatus.cancelled, cancelledAt: NOW }),
      );
      const result = await service.cancel(USER, RES_ID, NOW);
      expect(result.state).toBe(DriverReservationStateDto.cancelled);
    });

    it('no cancela ajenas, empezadas ni ya canceladas', async () => {
      prisma.reservation.findUnique.mockResolvedValue(row({ userId: 'otro' }));
      await expectFailure(
        service.cancel(USER, RES_ID, NOW),
        HttpStatus.NOT_FOUND,
        'RESERVATION_NOT_FOUND',
      );
      prisma.reservation.findUnique.mockResolvedValue(
        row({ entryAt: ar('2026-09-27T15:00:00') }),
      );
      await expectFailure(
        service.cancel(USER, RES_ID, NOW),
        HttpStatus.CONFLICT,
        'RESERVATION_NOT_CANCELLABLE',
      );
    });
  });
});
