import { HttpStatus } from '@nestjs/common';
import { MpAccountStatus, ScheduleDay, ServiceCode } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ServicesService } from './services.service';

const RATE_ID = '0192f2a0-0000-7000-8000-000000000001';

/** Fila de `services` con los defaults de la migración. */
const row = (overrides: object = {}) => ({
  enabled: false,
  reservationRateId: null,
  reservableSpots: null,
  reservationVehicleKinds: [],
  reservationHoursMode: 'opening',
  acceptanceMode: 'auto',
  approvalWindowMinutes: 15,
  freeCancelMinutes: 60,
  lateCancelRefundPct: 0,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  ...overrides,
});

/** Una fila con todo lo necesario para activar (falta sólo el flag). */
const readyRow = (overrides: object = {}) =>
  row({
    reservationRateId: RATE_ID,
    reservableSpots: 6,
    reservationVehicleKinds: ['car'],
    ...overrides,
  });

const range = (day: ScheduleDay, open: number, close: number) => ({
  day,
  openMinute: open * 60,
  closeMinute: close * 60,
});

describe('ServicesService', () => {
  const mockTenant = {
    service: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    rate: { findFirst: jest.fn() },
    schedule: { count: jest.fn(), findMany: jest.fn() },
    reservationHour: { count: jest.fn(), findMany: jest.fn() },
    reservation: { count: jest.fn() },
  };
  const mockTx = {
    service: { updateMany: jest.fn(), create: jest.fn() },
    reservationHour: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
    tenant: { findUnique: jest.fn() },
    mpAccount: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };
  const service = new ServicesService(
    mockPrisma as unknown as PrismaService,
    mockTenantContext as unknown as TenantContextService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockTenant.rate.findFirst.mockResolvedValue({ id: RATE_ID });
    mockTenant.service.findFirst.mockResolvedValue(null);
    mockTenant.schedule.count.mockResolvedValue(7);
    mockTenant.schedule.findMany.mockResolvedValue([
      range(ScheduleDay.monday, 8, 20),
    ]);
    mockTenant.reservationHour.count.mockResolvedValue(0);
    mockTenant.reservationHour.findMany.mockResolvedValue([]);
    mockTenant.reservation.count.mockResolvedValue(0);
    mockPrisma.tenant.findUnique.mockResolvedValue({
      settings: { capacity: { total: 20 } },
    });
    mockPrisma.mpAccount.findUnique.mockResolvedValue({
      status: MpAccountStatus.linked,
    });
    mockPrisma.$transaction.mockImplementation(
      (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
    );
  });

  describe('listServices', () => {
    it('devuelve la configuración, la readiness y las reservas pagas', async () => {
      mockTenant.service.findMany.mockResolvedValue([
        readyRow({ enabled: true, code: ServiceCode.ADVANCE_RESERVATION }),
      ]);
      mockTenant.reservation.count.mockResolvedValue(3);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.listServices()).resolves.toEqual([
        {
          code: ServiceCode.ADVANCE_RESERVATION,
          enabled: true,
          reservationRateId: RATE_ID,
          reservableSpots: 6,
          reservationVehicleKinds: ['car'],
          reservationHoursMode: 'opening',
          acceptanceMode: 'auto',
          approvalWindowMinutes: 15,
          freeCancelMinutes: 60,
          lateCancelRefundPct: 0,
          earlyArrivalMinutes: 15,
          graceMinutes: 30,
          readiness: { ready: true, missing: [] },
          upcomingPaidReservations: 3,
        },
      ]);
      expect(mockTenant.reservation.count).toHaveBeenCalledWith({
        where: {
          status: { in: ['pending_approval', 'confirmed'] },
          entryAt: { gt: expect.any(Date) as unknown as Date },
        },
      });
    });

    it('sin fila devuelve los defaults y todo lo que falta', async () => {
      mockTenant.service.findMany.mockResolvedValue([]);
      mockPrisma.mpAccount.findUnique.mockResolvedValue(null);

      const [item] = await service.listServices();

      expect(item).toMatchObject({
        enabled: false,
        reservationRateId: null,
        reservableSpots: null,
        reservationVehicleKinds: [],
        reservationHoursMode: 'opening',
        graceMinutes: 30,
        readiness: {
          ready: false,
          missing: ['mp_account', 'spots', 'vehicles', 'rate'],
        },
      });
    });

    it('cada requisito se evalúa por separado', async () => {
      mockTenant.service.findMany.mockResolvedValue([
        readyRow({ code: ServiceCode.ADVANCE_RESERVATION }),
      ]);

      mockPrisma.mpAccount.findUnique.mockResolvedValue({
        status: MpAccountStatus.revoked,
      });
      expect((await service.listServices())[0].readiness.missing).toEqual([
        'mp_account',
      ]);

      mockPrisma.mpAccount.findUnique.mockResolvedValue({
        status: MpAccountStatus.linked,
      });
      mockTenant.schedule.count.mockResolvedValue(0);
      expect((await service.listServices())[0].readiness.missing).toEqual([
        'hours',
      ]);

      mockTenant.schedule.count.mockResolvedValue(7);
      mockTenant.rate.findFirst.mockResolvedValue(null);
      expect((await service.listServices())[0].readiness.missing).toEqual([
        'rate',
      ]);
    });
  });

  describe('updateService', () => {
    it('guarda la tarifa y el cupo de reservas', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue(
        row({ reservationRateId: RATE_ID, reservableSpots: 6 }),
      );

      const result = await service.updateService(
        ServiceCode.ADVANCE_RESERVATION,
        { reservationRateId: RATE_ID, reservableSpots: 6 },
      );

      expect(mockTenant.rate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RATE_ID, deletedAt: null, isActive: true },
        }),
      );
      expect(mockTenant.service.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', code: ServiceCode.ADVANCE_RESERVATION },
        data: {
          version: { increment: 1 },
          reservationRateId: RATE_ID,
          reservableSpots: 6,
        },
      });
      expect(result).toMatchObject({
        code: ServiceCode.ADVANCE_RESERVATION,
        reservationRateId: RATE_ID,
        reservableSpots: 6,
      });
    });

    it('guarda las reglas de reserva', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue(
        row({ acceptanceMode: 'manual', graceMinutes: 45 }),
      );

      const result = await service.updateService(
        ServiceCode.ADVANCE_RESERVATION,
        {
          reservationVehicleKinds: ['car', 'motorcycle'],
          acceptanceMode: 'manual',
          graceMinutes: 45,
        },
      );

      expect(mockTenant.service.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', code: ServiceCode.ADVANCE_RESERVATION },
        data: {
          version: { increment: 1 },
          reservationVehicleKinds: ['car', 'motorcycle'],
          acceptanceMode: 'manual',
          graceMinutes: 45,
        },
      });
      expect(result).toMatchObject({
        acceptanceMode: 'manual',
        graceMinutes: 45,
      });
    });

    it('null desasocia la tarifa sin buscarla', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue(
        row({ reservableSpots: 6 }),
      );

      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservationRateId: null,
      });

      expect(mockTenant.rate.findFirst).not.toHaveBeenCalled();
      expect(mockTenant.service.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { version: { increment: 1 }, reservationRateId: null },
        }),
      );
    });

    it('crea la fila con la configuración si no existía', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 0 });
      mockTenant.service.create.mockResolvedValue(
        row({ reservationRateId: RATE_ID }),
      );

      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservationRateId: RATE_ID,
      });

      expect(mockTenant.service.create).toHaveBeenCalledWith({
        data: {
          ...row({ reservationRateId: RATE_ID }),
          code: 'ADVANCE_RESERVATION',
        },
      });
    });

    it('rechaza una tarifa inexistente, borrada o inactiva', async () => {
      mockTenant.rate.findFirst.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateService(ServiceCode.ADVANCE_RESERVATION, {
          reservationRateId: RATE_ID,
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({
          code: 'SERVICE_RESERVATION_RATE_NOT_FOUND',
        }) as unknown,
      });
      expect(mockTenant.service.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza un cupo mayor que la capacidad de la playa', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateService(ServiceCode.ADVANCE_RESERVATION, {
          reservableSpots: 21,
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({
          code: 'SERVICE_RESERVABLE_SPOTS_EXCEED_CAPACITY',
        }) as unknown,
      });
      expect(mockTenant.service.updateMany).not.toHaveBeenCalled();
    });

    it('acepta un cupo igual a la capacidad, o cualquiera sin capacidad declarada', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue(
        row({ reservableSpots: 20 }),
      );
      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservableSpots: 20,
      });

      mockPrisma.tenant.findUnique.mockResolvedValue({ settings: {} });
      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservableSpots: 50,
      });
      expect(mockTenant.service.updateMany).toHaveBeenCalledTimes(2);
    });

    it('rechaza un código desconocido', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateService('VEHICLE_CAR', { enabled: true }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({
          code: 'SERVICE_INVALID_CODE',
        }) as unknown,
      });
    });

    describe('activar', () => {
      it('sin estar listo responde 422 con lo que falta', async () => {
        mockTenant.service.findFirst.mockResolvedValue(
          row({ reservableSpots: 6 }),
        );
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(
          service.updateService(ServiceCode.ADVANCE_RESERVATION, {
            enabled: true,
          }),
        ).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            code: 'SERVICE_RESERVATION_NOT_READY',
            missing: ['mp_account', 'vehicles', 'rate'],
            validationsErrors: [
              expect.objectContaining({ field: 'readiness.mp_account' }),
              expect.objectContaining({ field: 'readiness.vehicles' }),
              expect.objectContaining({ field: 'readiness.rate' }),
            ],
          }) as unknown,
        });
        expect(mockTenant.service.updateMany).not.toHaveBeenCalled();
      });

      it('evalúa con lo que se va a guardar (el patch completa lo que falta)', async () => {
        mockTenant.service.findFirst.mockResolvedValue(
          row({ reservableSpots: 6 }),
        );
        mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
        mockTenant.service.findFirstOrThrow.mockResolvedValue(
          readyRow({ enabled: true }),
        );

        const result = await service.updateService(
          ServiceCode.ADVANCE_RESERVATION,
          {
            enabled: true,
            reservationRateId: RATE_ID,
            reservationVehicleKinds: ['car'],
          },
        );

        expect(result.enabled).toBe(true);
        expect(result.readiness).toEqual({ ready: true, missing: [] });
      });

      it('con MP desvinculada tampoco deja activar', async () => {
        mockTenant.service.findFirst.mockResolvedValue(readyRow());
        mockPrisma.mpAccount.findUnique.mockResolvedValue({
          status: MpAccountStatus.token_expired,
        });

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(
          service.updateService(ServiceCode.ADVANCE_RESERVATION, {
            enabled: true,
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            missing: ['mp_account'],
          }) as unknown,
        });
      });

      it('desactivar siempre se permite, aunque no esté listo', async () => {
        mockTenant.service.findFirst.mockResolvedValue(row({ enabled: true }));
        mockPrisma.mpAccount.findUnique.mockResolvedValue(null);
        mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
        mockTenant.service.findFirstOrThrow.mockResolvedValue(
          row({ enabled: false }),
        );

        const result = await service.updateService(
          ServiceCode.ADVANCE_RESERVATION,
          { enabled: false },
        );

        expect(result.enabled).toBe(false);
        expect(result.readiness.ready).toBe(false);
      });
    });

    it.each([
      ['reservationVehicleKinds', { reservationVehicleKinds: ['car'] }],
      ['acceptanceMode', { acceptanceMode: 'manual' }],
      ['approvalWindowMinutes', { approvalWindowMinutes: 30 }],
      ['freeCancelMinutes', { freeCancelMinutes: 30 }],
      ['lateCancelRefundPct', { lateCancelRefundPct: 50 }],
      ['earlyArrivalMinutes', { earlyArrivalMinutes: 30 }],
      ['graceMinutes', { graceMinutes: 30 }],
    ])(
      'rechaza %s en un código que no es ADVANCE_RESERVATION',
      async (_f, data) => {
        // `isServiceCode` valida contra el enum: hoy sólo existe
        // ADVANCE_RESERVATION, así que se fuerza otro código por el cast.
        const fake = 'VEHICLE_CAR' as ServiceCode;
        jest
          .spyOn(
            service as unknown as { isServiceCode: () => boolean },
            'isServiceCode',
          )
          .mockReturnValue(true);
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(service.updateService(fake, data)).rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'SERVICE_CONFIG_NOT_SUPPORTED',
          }) as unknown,
        });
        jest.restoreAllMocks();
      },
    );
  });

  describe('horarios de reservas', () => {
    it('GET devuelve el modo y los rangos ordenados', async () => {
      mockTenant.service.findFirst.mockResolvedValue({
        reservationHoursMode: 'custom',
      });
      mockTenant.reservationHour.findMany.mockResolvedValue([
        range(ScheduleDay.tuesday, 9, 12),
        range(ScheduleDay.monday, 14, 18),
        range(ScheduleDay.monday, 9, 12),
      ]);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.getReservationHours()).resolves.toEqual({
        mode: 'custom',
        ranges: [
          range(ScheduleDay.monday, 9, 12),
          range(ScheduleDay.monday, 14, 18),
          range(ScheduleDay.tuesday, 9, 12),
        ],
      });
    });

    it('GET sin fila devuelve opening y sin rangos', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.getReservationHours()).resolves.toEqual({
        mode: 'opening',
        ranges: [],
      });
    });

    it('PUT custom reemplaza el set completo en una transacción', async () => {
      mockTx.service.updateMany.mockResolvedValue({ count: 1 });
      const ranges = [
        range(ScheduleDay.monday, 9, 12),
        range(ScheduleDay.monday, 14, 18),
      ];

      await service.putReservationHours({ mode: 'custom', ranges });

      expect(mockTx.service.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', code: 'ADVANCE_RESERVATION' },
        data: { reservationHoursMode: 'custom', version: { increment: 1 } },
      });
      expect(mockTx.reservationHour.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1' },
      });
      expect(mockTx.reservationHour.createMany).toHaveBeenCalledWith({
        data: ranges.map((r) => ({ tenantId: 'tenant-1', ...r })),
      });
    });

    it('PUT crea la fila del servicio si no existía', async () => {
      mockTx.service.updateMany.mockResolvedValue({ count: 0 });

      await service.putReservationHours({
        mode: 'custom',
        ranges: [range(ScheduleDay.monday, 9, 12)],
      });

      expect(mockTx.service.create).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          code: 'ADVANCE_RESERVATION',
          reservationHoursMode: 'custom',
        },
      });
    });

    it('PUT opening borra los rangos propios aunque lleguen', async () => {
      mockTx.service.updateMany.mockResolvedValue({ count: 1 });

      await service.putReservationHours({
        mode: 'opening',
        ranges: [range(ScheduleDay.monday, 9, 12)],
      });

      expect(mockTx.reservationHour.deleteMany).toHaveBeenCalled();
      expect(mockTx.reservationHour.createMany).not.toHaveBeenCalled();
      expect(mockTx.service.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reservationHoursMode: 'opening',
          }) as unknown,
        }),
      );
    });

    it('PUT con rangos superpuestos o invertidos da 400 con el índice', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.putReservationHours({
          mode: 'custom',
          ranges: [
            range(ScheduleDay.monday, 9, 12),
            range(ScheduleDay.monday, 11, 14),
            range(ScheduleDay.monday, 18, 16),
          ],
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({
          code: 'RESERVATION_HOURS_INVALID',
          validationsErrors: [
            expect.objectContaining({ field: 'ranges.1', code: 'overlap' }),
            expect.objectContaining({
              field: 'ranges.2',
              code: 'invalid_range',
            }),
          ],
        }) as unknown,
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('PUT con rangos fuera de la apertura da 422', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.putReservationHours({
          mode: 'custom',
          ranges: [
            range(ScheduleDay.monday, 9, 12),
            range(ScheduleDay.monday, 19, 22),
            range(ScheduleDay.sunday, 9, 12),
          ],
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: expect.objectContaining({
          code: 'RESERVATION_HOURS_OUTSIDE_OPENING',
          validationsErrors: [
            expect.objectContaining({ field: 'ranges.1' }),
            expect.objectContaining({ field: 'ranges.2' }),
          ],
        }) as unknown,
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('PUT custom sin rangos se permite: la readiness lo marcará', async () => {
      mockTx.service.updateMany.mockResolvedValue({ count: 1 });

      await service.putReservationHours({ mode: 'custom', ranges: [] });

      expect(mockTx.reservationHour.createMany).not.toHaveBeenCalled();
      expect(mockTx.service.updateMany).toHaveBeenCalled();
    });
  });
});
