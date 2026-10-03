import { HttpStatus } from '@nestjs/common';
import { ServiceCode } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ServicesService } from './services.service';

const RATE_ID = '0192f2a0-0000-7000-8000-000000000001';

describe('ServicesService', () => {
  const mockTenant = {
    service: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    rate: { findFirst: jest.fn() },
  };
  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
    tenant: { findUnique: jest.fn() },
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
    mockPrisma.tenant.findUnique.mockResolvedValue({
      settings: { capacity: { total: 20 } },
    });
  });

  describe('listServices', () => {
    it('devuelve la configuración de reservas o null si no hay fila', async () => {
      mockTenant.service.findMany.mockResolvedValue([
        {
          code: ServiceCode.ADVANCE_RESERVATION,
          enabled: true,
          reservationRateId: RATE_ID,
          reservableSpots: 8,
        },
      ]);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.listServices()).resolves.toEqual([
        {
          code: ServiceCode.ADVANCE_RESERVATION,
          enabled: true,
          reservationRateId: RATE_ID,
          reservableSpots: 8,
        },
      ]);

      mockTenant.service.findMany.mockResolvedValue([]);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.listServices()).resolves.toEqual([
        {
          code: ServiceCode.ADVANCE_RESERVATION,
          enabled: false,
          reservationRateId: null,
          reservableSpots: null,
        },
      ]);
    });
  });

  describe('updateService', () => {
    it('guarda la tarifa y el cupo de reservas', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue({
        enabled: true,
        reservationRateId: RATE_ID,
        reservableSpots: 6,
      });

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
      expect(result).toEqual({
        code: ServiceCode.ADVANCE_RESERVATION,
        enabled: true,
        reservationRateId: RATE_ID,
        reservableSpots: 6,
      });
    });

    it('null desasocia la tarifa sin buscarla', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue({
        enabled: true,
        reservationRateId: null,
        reservableSpots: 6,
      });

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
      mockTenant.service.create.mockResolvedValue({
        enabled: false,
        reservationRateId: RATE_ID,
        reservableSpots: null,
      });

      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservationRateId: RATE_ID,
      });

      expect(mockTenant.service.create).toHaveBeenCalledWith({
        data: {
          code: ServiceCode.ADVANCE_RESERVATION,
          enabled: false,
          reservationRateId: RATE_ID,
          reservableSpots: null,
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
      mockTenant.service.findFirstOrThrow.mockResolvedValue({
        enabled: true,
        reservationRateId: null,
        reservableSpots: 20,
      });
      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservableSpots: 20,
      });

      mockPrisma.tenant.findUnique.mockResolvedValue({ settings: {} });
      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        reservableSpots: 50,
      });
      expect(mockTenant.service.updateMany).toHaveBeenCalledTimes(2);
    });

    it('no consulta la capacidad si no cambia el cupo', async () => {
      mockTenant.service.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.service.findFirstOrThrow.mockResolvedValue({
        enabled: true,
        reservationRateId: null,
        reservableSpots: null,
      });
      await service.updateService(ServiceCode.ADVANCE_RESERVATION, {
        enabled: true,
      });
      expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
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
  });
});
