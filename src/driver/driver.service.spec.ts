import { HttpStatus } from '@nestjs/common';
import {
  MpAccountStatus,
  Prisma,
  ScheduleDay,
  type User,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverService } from './driver.service';

const mockTenantClient = {
  schedule: { findMany: jest.fn() },
  service: { findFirst: jest.fn() },
  reservationHour: { findMany: jest.fn() },
  entry: { count: jest.fn() },
  reservation: { findMany: jest.fn() },
};

// `prismaForTenant(prisma, id)` es `prisma.$extends(...)`: el cliente acotado
// del test sale de ese `$extends` falso. Así se ejercita el camino real del
// service (una lectura acotada por playa) sin mockear módulos.

const USER = { id: 'user-1' } as User;

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

/** Fila del servicio de reservas lista para tomar reservas (defaults de la migración). */
const reservationService = (overrides: object = {}) => ({
  enabled: true,
  reservableSpots: 5,
  reservationVehicleKinds: ['car', 'suv_pickup'],
  reservationHoursMode: 'opening',
  acceptanceMode: 'auto',
  freeCancelMinutes: 60,
  lateCancelRefundPct: 0,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  reservationRate: reservationRate(1800),
  ...overrides,
});

describe('DriverService', () => {
  const prisma = {
    tenant: { findMany: jest.fn(), findFirst: jest.fn() },
    mpAccount: { findUnique: jest.fn() },
    $extends: jest.fn(() => mockTenantClient),
  };
  const driverVehicles = { findOwnedKind: jest.fn() };
  const service = new DriverService(
    prisma as unknown as PrismaService,
    driverVehicles as unknown as DriverVehiclesService,
  );

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
    mockTenantClient.service.findFirst.mockResolvedValue(reservationService());
    mockTenantClient.reservationHour.findMany.mockResolvedValue([]);
    prisma.mpAccount.findUnique.mockResolvedValue({
      status: MpAccountStatus.linked,
    });
    driverVehicles.findOwnedKind.mockResolvedValue('car');
    mockTenantClient.entry.count.mockResolvedValue(8);
    mockTenantClient.reservation.findMany.mockResolvedValue([]);
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
        reservationFractionPriceArs: 150,
        reservationVehicleKinds: ['car', 'suv_pickup'],
        reservationRules: {
          acceptanceMode: 'auto',
          freeCancelMinutes: 60,
          lateCancelRefundPct: 0,
          earlyArrivalMinutes: 15,
          graceMinutes: 30,
        },
        openNow: true,
      });
      // Modo opening: el horario de reservas es el de apertura.
      expect(parking.reservationHours).toHaveLength(7);
      expect(parking.reservationHours?.[0]).toEqual({
        day: 'monday',
        openMinute: 7 * 60,
        closeMinute: 23 * 60,
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
      ['sin tipos de vehículo', { reservationVehicleKinds: [] }],
      ['más cupo que la capacidad', { reservableSpots: 21 }],
    ])('no toma reservas con %s', async (_, overrides) => {
      mockTenantClient.service.findFirst.mockResolvedValue(
        reservationService(overrides),
      );

      const [parking] = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
        NOW,
      );
      expect(parking).toMatchObject({
        acceptsReservations: false,
        reservationHourPriceArs: null,
        reservationFractionPriceArs: null,
        reservationVehicleKinds: null,
        reservationHours: null,
        reservationRules: null,
      });
    });

    it.each([
      ['sin cuenta de Mercado Pago', null],
      [
        'con la cuenta con token vencido',
        { status: MpAccountStatus.token_expired },
      ],
      ['con la cuenta revocada', { status: MpAccountStatus.revoked }],
    ])(
      'no toma reservas %s aunque el servicio esté activo',
      async (_, account) => {
        prisma.mpAccount.findUnique.mockResolvedValue(account);

        const [parking] = await service.findNearby(
          { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
          NOW,
        );
        expect(parking.acceptsReservations).toBe(false);
        expect(prisma.mpAccount.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { tenantId: 'tenant-once' } }),
        );
      },
    );

    it('con horario propio expone esos rangos y no los de apertura', async () => {
      mockTenantClient.service.findFirst.mockResolvedValue(
        reservationService({ reservationHoursMode: 'custom' }),
      );
      mockTenantClient.reservationHour.findMany.mockResolvedValue([
        { day: ScheduleDay.saturday, openMinute: 9 * 60, closeMinute: 13 * 60 },
        { day: ScheduleDay.monday, openMinute: 8 * 60, closeMinute: 20 * 60 },
      ]);

      const [parking] = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
        NOW,
      );
      expect(parking.reservationHours).toEqual([
        { day: 'monday', openMinute: 8 * 60, closeMinute: 20 * 60 },
        { day: 'saturday', openMinute: 9 * 60, closeMinute: 13 * 60 },
      ]);
    });

    it('en modo custom sin rangos no toma reservas', async () => {
      mockTenantClient.service.findFirst.mockResolvedValue(
        reservationService({ reservationHoursMode: 'custom' }),
      );
      const [parking] = await service.findNearby(
        { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
        NOW,
      );
      expect(parking.acceptsReservations).toBe(false);
    });
  });

  it('la tolerancia de la playa decide cuánto tiempo ocupa lugar una reserva', async () => {
    mockTenantClient.service.findFirst.mockResolvedValue(
      reservationService({ graceMinutes: 120 }),
    );
    mockTenantClient.reservation.findMany.mockResolvedValue([
      { entryAt: ar('2026-09-27T14:30:00') }, // vence 16:30 con 120 min: ocupa
    ]);
    const [parking] = await service.findNearby(
      { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
      NOW,
    );
    expect(parking.availableSpots).toBe(11);
  });

  it('descuenta las reservas de hoy que todavía ocupan lugar', async () => {
    mockTenantClient.reservation.findMany.mockResolvedValue([
      { entryAt: ar('2026-09-27T18:00:00') }, // más tarde hoy: ocupa
      { entryAt: ar('2026-09-27T15:40:00') }, // vigente (vence 16:10)
      { entryAt: ar('2026-09-27T11:00:00') }, // vencida: no ocupa
    ]);
    const [parking] = await service.findNearby(
      { latitude: -34.6037, longitude: -58.3816, radiusMeters: 5000 },
      NOW,
    );
    // 20 de capacidad − 8 adentro − 2 reservas vigentes.
    expect(parking.availableSpots).toBe(10);
  });

  describe('quote', () => {
    const window = {
      entryAt: ar('2026-09-28T10:00:00').toISOString(),
      exitAt: ar('2026-09-28T13:00:00').toISOString(),
    };

    it('cotiza con el motor de cobro y la tarifa de reservas', async () => {
      const quote = await service.quote('tenant-once', window, USER, NOW);

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
          USER,
          NOW,
        ),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RESERVATION_OUTSIDE_OPENING_HOURS',
      );
    });

    it('rechaza reservar si la playa no toma reservas', async () => {
      mockTenantClient.service.findFirst.mockResolvedValue(
        reservationService({ reservationRate: null }),
      );
      await expectRejection(
        service.quote('tenant-once', window, USER, NOW),
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
          USER,
          NOW,
        ),
        HttpStatus.BAD_REQUEST,
        'RESERVATION_ENTRY_TOO_FAR',
      );
    });

    describe('con vehiclePlate', () => {
      const withPlate = { ...window, vehiclePlate: 'AB123CD' };

      it('cotiza si el tipo del vehículo está aceptado', async () => {
        driverVehicles.findOwnedKind.mockResolvedValue('suv_pickup');
        const quote = await service.quote('tenant-once', withPlate, USER, NOW);
        expect(quote.totalArs).toBe(5400);
        expect(driverVehicles.findOwnedKind).toHaveBeenCalledWith(
          USER,
          'AB123CD',
        );
      });

      it('rechaza un tipo de vehículo que la playa no acepta', async () => {
        driverVehicles.findOwnedKind.mockResolvedValue('motorcycle');
        await expectRejection(
          service.quote('tenant-once', withPlate, USER, NOW),
          HttpStatus.UNPROCESSABLE_ENTITY,
          'RESERVATION_VEHICLE_KIND_NOT_ACCEPTED',
        );
      });

      it('rechaza una patente que no es del conductor', async () => {
        driverVehicles.findOwnedKind.mockResolvedValue(null);
        await expectRejection(
          service.quote('tenant-once', withPlate, USER, NOW),
          HttpStatus.UNPROCESSABLE_ENTITY,
          'RESERVATION_VEHICLE_NOT_FOUND',
        );
      });

      it('sin patente no valida el tipo de vehículo', async () => {
        await service.quote('tenant-once', window, USER, NOW);
        expect(driverVehicles.findOwnedKind).not.toHaveBeenCalled();
      });

      it('quoteForReservation valida el tipo que le pasan', async () => {
        await expectRejection(
          service.quoteForReservation('tenant-once', window, NOW, 'motorcycle'),
          HttpStatus.UNPROCESSABLE_ENTITY,
          'RESERVATION_VEHICLE_KIND_NOT_ACCEPTED',
        );
      });
    });

    describe('con horario propio de reservas', () => {
      beforeEach(() => {
        mockTenantClient.service.findFirst.mockResolvedValue(
          reservationService({ reservationHoursMode: 'custom' }),
        );
        // Mar 09:00–13:00 (2026-09-29 es martes).
        mockTenantClient.reservationHour.findMany.mockResolvedValue([
          {
            day: ScheduleDay.tuesday,
            openMinute: 9 * 60,
            closeMinute: 13 * 60,
          },
        ]);
      });

      const tuesday = (from: string, to: string) => ({
        entryAt: ar(`2026-09-29T${from}:00`).toISOString(),
        exitAt: ar(`2026-09-29T${to}:00`).toISOString(),
      });

      it('cotiza una estadía dentro de los rangos', async () => {
        const quote = await service.quote(
          'tenant-once',
          tuesday('10:00', '12:00'),
          USER,
          NOW,
        );
        expect(quote.totalArs).toBe(3600);
      });

      it.each([
        ['empieza antes', '08:00', '10:00'],
        ['termina después', '12:00', '14:00'],
        ['queda del todo afuera', '15:00', '17:00'],
      ])('rechaza una estadía que %s', async (_n, from, to) => {
        await expectRejection(
          service.quote('tenant-once', tuesday(from, to), USER, NOW),
          HttpStatus.UNPROCESSABLE_ENTITY,
          'RESERVATION_OUTSIDE_RESERVATION_HOURS',
        );
      });

      it('mantiene el chequeo de la apertura (va primero)', async () => {
        await expectRejection(
          service.quote(
            'tenant-once',
            {
              entryAt: ar('2026-09-29T21:00:00').toISOString(),
              exitAt: ar('2026-09-30T01:00:00').toISOString(),
            },
            USER,
            NOW,
          ),
          HttpStatus.UNPROCESSABLE_ENTITY,
          'RESERVATION_OUTSIDE_OPENING_HOURS',
        );
      });
    });

    it('devuelve 404 si la playa no es pública', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);
      await expectRejection(
        service.quote('otra', window, USER, NOW),
        HttpStatus.NOT_FOUND,
        'DRIVER_PARKING_NOT_FOUND',
      );
    });
  });
});
