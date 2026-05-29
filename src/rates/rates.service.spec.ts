import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatesService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
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
      const rows = [{ id: 'r-1', name: 'DIA AUTO' }];
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
        { id: 'r-1', syncSeq: 10 },
        { id: 'r-2', syncSeq: 11 },
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
  });
});
