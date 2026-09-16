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
      deleteMany: jest.fn(),
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
    mediaEstadiaPriceArs: new Prisma.Decimal(1000),
    autoFractionPrice: false,
    isActive: true,
    shortcutNumber: null,
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
    it('should call tenant-scoped prisma client and coerce Decimal prices', async () => {
      mockTenant.rate.findMany.mockResolvedValue([makeRate()]);

      const result = await service.listRates({});

      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.rate.findMany).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r-1');
      expect(result[0].hourPriceArs).toBe(1000);
      expect(result[0].stayPriceArs).toBe(2000);
      expect(result[0].fractionPriceArs).toBe(300);
      // Sin el Number() explícito en toDto esto llega como el string "1000":
      // el spread deja pasar el Decimal tal cual.
      expect(result[0].mediaEstadiaPriceArs).toBe(1000);
    });

    it('should exclude soft-deleted rates', async () => {
      mockTenant.rate.findMany.mockResolvedValue([]);

      await service.listRates({});

      expect(mockTenant.rate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, isActive: true },
        }),
      );
    });

    // `includeInactive` is about `isActive` (deactivated, still reactivable in
    // the owner panel). A soft-deleted rate must stay hidden either way — the
    // web ABM renders whatever this endpoint returns.
    it('should exclude soft-deleted rates even when includeInactive is set', async () => {
      mockTenant.rate.findMany.mockResolvedValue([]);

      await service.listRates({ includeInactive: true });

      expect(mockTenant.rate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
        }),
      );
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

    it('should echo afterSeq when the page is empty', async () => {
      mockTenant.rate.findMany.mockResolvedValue([]);

      const result = await service.pullChanges({ afterSeq: 7, limit: 50 });

      expect(result.items).toEqual([]);
      expect(result.maxSeq).toBe(7);
    });

    // The whole point of the soft delete: the feed must NOT filter deletedAt,
    // because a marked row is the only signal a client gets about a deletion.
    it('should ship soft-deleted rows as tombstones', async () => {
      const deletedAt = new Date('2026-08-31T12:00:00.000Z');
      mockTenant.rate.findMany.mockResolvedValue([
        makeRate({ id: 'r-1', syncSeq: 12, deletedAt }),
      ]);

      const result = await service.pullChanges({ afterSeq: 5, limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].deletedAt).toEqual(deletedAt);
      expect(mockTenant.rate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { syncSeq: { gt: 5 } },
        }),
      );
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

  describe('deleteRate', () => {
    it('should stamp deletedAt and bump version instead of removing the row', async () => {
      mockTenant.rate.updateMany.mockResolvedValue({ count: 1 });

      await service.deleteRate('rate-id', 3);

      expect(mockTenant.rate.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          id: 'rate-id',
          version: 3,
          deletedAt: null,
        },
        data: {
          deletedAt: expect.any(Date) as Date,
          version: { increment: 1 },
        },
      });
      expect(mockTenant.rate.deleteMany).not.toHaveBeenCalled();
    });

    // `deletedAt: null` in the where clause is what makes a repeated DELETE
    // conflict instead of re-stamping the mark and re-emitting the tombstone.
    it('should throw conflict when the rate is missing, stale or already deleted', async () => {
      mockTenant.rate.updateMany.mockResolvedValue({ count: 0 });

      const promise = service.deleteRate('rate-id', 1);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toBeInstanceOf(FormattedException);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });
  });
});
