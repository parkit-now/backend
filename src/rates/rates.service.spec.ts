import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { RatesService } from './rates.service';

describe('RatesService', () => {
  let service: RatesService;

  const mockTenant = {
    rate: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  const mockTenantContext = {
    getTenantIdOrThrow: jest.fn().mockReturnValue('tenant-1'),
  };

  const makeRate = (
    overrides: Partial<Prisma.RateGetPayload<Record<string, never>>> = {},
  ): Prisma.RateGetPayload<Record<string, never>> => ({
    id: 'r-1',
    tenantId: 'tenant-1',
    name: 'DIA AUTO',
    hourPriceArs: new Prisma.Decimal(1000),
    stayPriceArs: new Prisma.Decimal(2000),
    fractionPriceArs: new Prisma.Decimal(300),
    isActive: true,
    version: 1,
    syncSeq: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatesService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: TenantContextService,
          useValue: mockTenantContext,
        },
      ],
    }).compile();

    service = module.get<RatesService>(RatesService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listRates', () => {
    it('should call tenant-scoped prisma client', async () => {
      const rows = [makeRate()];
      mockTenant.rate.findMany.mockResolvedValue(rows);

      const result = await service.listRates({});

      expect(result).toEqual(rows);
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.rate.findMany).toHaveBeenCalled();
    });
  });

  describe('pullChanges', () => {
    it('should return maxSeq from last item when rows exist', async () => {
      mockTenant.rate.findMany.mockResolvedValue([
        makeRate({ id: 'r-1', syncSeq: 10 }),
        makeRate({ id: 'r-2', syncSeq: 11 }),
      ]);

      const result = await service.pullChanges({ afterSeq: 5, limit: 50 });

      expect(result.maxSeq).toBe(11);
      expect(result.items).toHaveLength(2);
    });
  });

  describe('updateRate', () => {
    it('should throw conflict when expected version does not match', async () => {
      mockTenant.rate.updateMany.mockResolvedValue({ count: 0 });

      const promise = service.updateRate('rate-id', 2, { name: 'nuevo' });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('should include tenantId in updateMany where clause', async () => {
      mockTenant.rate.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.rate.findUniqueOrThrow.mockResolvedValue({ id: 'rate-id' });

      await service.updateRate('rate-id', 2, { name: 'nuevo' });

      expect(mockTenant.rate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant-1',
            id: 'rate-id',
            version: 2,
            deletedAt: null,
          },
        }),
      );
    });
  });
});
