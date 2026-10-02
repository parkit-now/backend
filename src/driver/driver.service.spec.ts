import { HttpStatus } from '@nestjs/common';
import { Prisma, ScheduleDay } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { DriverService } from './driver.service';

const mockTenantClient = {
  schedule: { findMany: jest.fn() },
  service: { findFirst: jest.fn() },
  entry: { count: jest.fn() },
};

// `prismaForTenant(prisma, id)` es `prisma.$extends(...)`: el cliente acotado
// del test sale de ese `$extends` falso. Así se ejercita el camino real del
// service (una lectura acotada por playa) sin mockear módulos.

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');

const tenant = {
  id: 'tenant-once',
  name: 'Estacionamiento Once',
  address: 'Bartolomé Mitre 2500, CABA',
  latitude: new Prisma.Decimal(-34.6098),
  longitude: new Prisma.Decimal(-58.4079),
  settings: { capacity: { total: 20 } },
};

const reservationRate = (hour: number, overrides: object = {}) => ({
  name: 'RESERVAS',
  hourPriceArs: new Prisma.Decimal(hour),
  fractionPriceArs: new Prisma.Decimal(hour / 12),
  mediaEstadiaPriceArs: new Prisma.Decimal(hour * 6),
  stayPriceArs: new Prisma.Decimal(hour * 10),
  isActive: true,
  deletedAt: null,
  ...overrides,
});

describe('DriverService', () => {
  const prisma = {
    tenant: { findMany: jest.fn(), findFirst: jest.fn() },
    $extends: jest.fn(() => mockTenantClient),
  };
  const service = new DriverService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findFirst.mockResolvedValue(tenant);
    prisma.tenant.findMany.mockResolvedValue([tenant]);
    mockTenantClient.schedule.findMany.mockResolvedValue(
      Object.values(ScheduleDay).map((day) => ({
        day,
        openMinute: 7 * 60,
        closeMinute: 23 * 60,
      })),
    );
    mockTenantClient.service.findFirst.mockResolvedValue({
      enabled: true,
      reservableSpots: 5,
      reservationRate: reservationRate(1800),
    });
    mockTenantClient.entry.count.mockResolvedValue(8);
  });

  describe('findNearby', () => {
    it('arma el contrato público con disponibilidad y precio de reserva', async () => {
      const [parking] = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
        NOW,
      );

      expect(parking).toMatchObject({
        id: 'tenant-once',
        availableSpots: 12,
        totalSpots: 20,
        acceptsReservations: true,
        reservationHourPriceArs: 1800,
        openNow: true,
      });
      expect(parking.distanceMeters).toBeGreaterThan(2400);
      expect(parking).not.toHaveProperty('settings');
    });

    it('descarta las playas de la caja que quedan fuera del radio', async () => {
      const result = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 1000 },
        NOW,
      );
      expect(result).toEqual([]);
    });

    it.each([
      ['el servicio apagado', { enabled: false }],
      ['sin tarifa elegida', { reservationRate: null }],
      [
        'la tarifa inactiva',
        { reservationRate: reservationRate(1800, { isActive: false }) },
      ],
      [
        'la tarifa borrada',
        { reservationRate: reservationRate(1800, { deletedAt: NOW }) },
      ],
      ['sin cupo', { reservableSpots: 0 }],
    ])('no toma reservas con %s', async (_, overrides) => {
      mockTenantClient.service.findFirst.mockResolvedValue({
        enabled: true,
        reservableSpots: 5,
        reservationRate: reservationRate(1800),
        ...overrides,
      });

      const [parking] = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
        NOW,
      );
      expect(parking).toMatchObject({
        acceptsReservations: false,
        reservationHourPriceArs: null,
      });
    });
  });

  describe('quote', () => {
    const window = {
      entryAt: ar('2026-09-28T10:00:00').toISOString(),
      exitAt: ar('2026-09-28T13:00:00').toISOString(),
    };

    it('cotiza con el motor de cobro y la tarifa de reservas', async () => {
      const quote = await service.quote('tenant-once', window, NOW);

      expect(quote).toMatchObject({
        durationMinutes: 180,
        totalArs: 5400,
        rate: { name: 'RESERVAS', hourPriceArs: 1800 },
      });
    });

    const expectRejection = async (
      promise: Promise<unknown>,
      status: HttpStatus,
      code: string,
    ) => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status,
        response: expect.objectContaining({ code }) as unknown,
      });
    };

    it('rechaza una estadía que cruza el cierre', async () => {
      await expectRejection(
        service.quote(
          'tenant-once',
          {
            entryAt: ar('2026-09-28T21:00:00').toISOString(),
            exitAt: ar('2026-09-29T01:00:00').toISOString(),
          },
          NOW,
        ),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RESERVATION_OUTSIDE_OPENING_HOURS',
      );
    });

    it('rechaza reservar si la playa no toma reservas', async () => {
      mockTenantClient.service.findFirst.mockResolvedValue({
        enabled: true,
        reservableSpots: 5,
        reservationRate: null,
      });
      await expectRejection(
        service.quote('tenant-once', window, NOW),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DRIVER_RESERVATIONS_DISABLED',
      );
    });

    it('rechaza una ventana a más de 7 días', async () => {
      await expectRejection(
        service.quote(
          'tenant-once',
          {
            entryAt: ar('2026-10-06T10:00:00').toISOString(),
            exitAt: ar('2026-10-06T12:00:00').toISOString(),
          },
          NOW,
        ),
        HttpStatus.BAD_REQUEST,
        'RESERVATION_ENTRY_TOO_FAR',
      );
    });

    it('devuelve 404 si la playa no es pública', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);
      await expectRejection(
        service.quote('otra', window, NOW),
        HttpStatus.NOT_FOUND,
        'DRIVER_PARKING_NOT_FOUND',
      );
    });
  });
});
