import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, ScheduleDay } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { SchedulesService } from './schedules.service';

describe('SchedulesService', () => {
  let service: SchedulesService;

  const mockTenant = {
    schedule: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  const makeSchedule = (
    overrides: Partial<Prisma.ScheduleGetPayload<Record<string, never>>> = {},
  ): Prisma.ScheduleGetPayload<Record<string, never>> => ({
    id: 's-1',
    tenantId: 'tenant-1',
    day: ScheduleDay.monday,
    openMinute: 480,
    closeMinute: 720,
    version: 1,
    syncSeq: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
      ],
    }).compile();

    service = module.get<SchedulesService>(SchedulesService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createSchedule', () => {
    it('rejects an invalid range (close <= open)', async () => {
      const promise = service.createSchedule({
        day: ScheduleDay.monday,
        openMinute: 720,
        closeMinute: 720,
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
      expect(mockTenant.schedule.create).not.toHaveBeenCalled();
    });

    it('rejects an overlapping range on the same day', async () => {
      mockTenant.schedule.findFirst.mockResolvedValue(makeSchedule());

      const promise = service.createSchedule({
        day: ScheduleDay.monday,
        openMinute: 600,
        closeMinute: 800,
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
      expect(mockTenant.schedule.create).not.toHaveBeenCalled();
    });

    it('creates a non-overlapping range', async () => {
      mockTenant.schedule.findFirst.mockResolvedValue(null);
      const created = makeSchedule({ openMinute: 800, closeMinute: 1000 });
      mockTenant.schedule.create.mockResolvedValue(created);

      const result = await service.createSchedule({
        day: ScheduleDay.monday,
        openMinute: 800,
        closeMinute: 1000,
      });

      expect(result).toEqual(created);
      expect(mockTenant.schedule.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            day: ScheduleDay.monday,
            openMinute: { lt: 1000 },
            closeMinute: { gt: 800 },
          },
        }),
      );
    });
  });

  describe('updateSchedule', () => {
    it('throws conflict when expected version does not match', async () => {
      mockTenant.schedule.findUnique.mockResolvedValue(makeSchedule());
      mockTenant.schedule.findFirst.mockResolvedValue(null);
      mockTenant.schedule.updateMany.mockResolvedValue({ count: 0 });

      const promise = service.updateSchedule('s-1', 2, { openMinute: 500 });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('throws not found when the schedule does not exist', async () => {
      mockTenant.schedule.findUnique.mockResolvedValue(null);

      const promise = service.updateSchedule('missing', 1, { openMinute: 500 });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('excludes itself from the overlap check', async () => {
      mockTenant.schedule.findUnique.mockResolvedValue(makeSchedule());
      mockTenant.schedule.findFirst.mockResolvedValue(null);
      mockTenant.schedule.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.schedule.findUniqueOrThrow.mockResolvedValue(makeSchedule());

      await service.updateSchedule('s-1', 1, { closeMinute: 700 });

      expect(mockTenant.schedule.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            day: ScheduleDay.monday,
            id: { not: 's-1' },
            openMinute: { lt: 700 },
            closeMinute: { gt: 480 },
          },
        }),
      );
      expect(mockTenant.schedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', id: 's-1', version: 1 },
        }),
      );
    });
  });
});
