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
      findFirst: jest.fn(),
    },
    entry: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockPrisma = {
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
    // `updateRate` corre dentro de una transacción. El doble ejecuta el
    // callback con el mismo mock, así que las aserciones siguen siendo sobre
    // `mockTenant` — lo que importa verificar es QUÉ se escribe, no que Prisma
    // sepa abrir una transacción.
    $transaction: jest.fn((cb: (tx: typeof mockTenant) => unknown): unknown =>
      cb(mockTenant),
    ),
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

  describe('updateRate y la propagación a los autos adentro', () => {
    const abiertas = [
      { id: 'e-1', plate: 'AA111AA', ticketNumber: 1 },
      { id: 'e-2', plate: 'BB222BB', ticketNumber: 2 },
    ];

    function tarifaEditada() {
      const before = makeRate();
      const after = makeRate({
        hourPriceArs: new Prisma.Decimal(3900),
        version: 2,
      });
      mockTenant.rate.findFirst.mockResolvedValue(before);
      mockTenant.rate.updateMany.mockResolvedValue({ count: 1 });
      mockTenant.rate.findUniqueOrThrow.mockResolvedValue(after);
      return after;
    }

    it('reescribe los cuatro precios del snapshot desde la tarifa ya actualizada', async () => {
      const after = tarifaEditada();
      mockTenant.entry.findMany.mockResolvedValue(abiertas);
      mockTenant.entry.updateMany.mockResolvedValue({ count: 2 });

      await service.updateRate('r-1', 1, {
        hourPriceArs: 3900,
        applyToOpenEntries: true,
      });

      const [args] = mockTenant.entry.updateMany.mock.calls[0] as [
        { where: unknown; data: Record<string, unknown> },
      ];
      expect(args.where).toEqual({
        tenantId: 'tenant-1',
        id: { in: ['e-1', 'e-2'] },
      });
      expect(args.data).toEqual({
        rateSnapshotHourPriceArs: after.hourPriceArs,
        rateSnapshotFractionPriceArs: after.fractionPriceArs,
        rateSnapshotMediaEstadiaPriceArs: after.mediaEstadiaPriceArs,
        rateSnapshotStayPriceArs: after.stayPriceArs,
      });
    });

    it('NO incrementa la version de las estadías: un 409 al salir es un auto trabado', async () => {
      // `version` en `entries` es el token de concurrencia del EGRESO. Si este
      // lote lo tocara, todo cobro que llegue con la versión cacheada rebotaría
      // con 409 y el auto se quedaría en la barrera porque el dueño cambió un
      // precio desde la web. No hay lost-update que proteger: el cobro no
      // escribe ningún campo del snapshot.
      tarifaEditada();
      mockTenant.entry.findMany.mockResolvedValue(abiertas);
      mockTenant.entry.updateMany.mockResolvedValue({ count: 2 });

      await service.updateRate('r-1', 1, {
        hourPriceArs: 3900,
        applyToOpenEntries: true,
      });

      const [args] = mockTenant.entry.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).not.toHaveProperty('version');
    });

    it('no toca el nombre del snapshot', async () => {
      // Renombrar una tarifa no pregunta nada, así que propagar el nombre sería
      // una regla inconsistente y una sorpresa en el ticket.
      tarifaEditada();
      mockTenant.entry.findMany.mockResolvedValue(abiertas);
      mockTenant.entry.updateMany.mockResolvedValue({ count: 2 });

      await service.updateRate('r-1', 1, {
        name: 'OTRO NOMBRE',
        hourPriceArs: 3900,
        applyToOpenEntries: true,
      });

      const [args] = mockTenant.entry.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).not.toHaveProperty('rateSnapshotName');
    });

    it('sin el flag no toca ninguna estadía', async () => {
      // La regresión del comportamiento histórico: por defecto el snapshot es
      // inmutable y un auto adentro conserva el precio con el que entró.
      tarifaEditada();

      await service.updateRate('r-1', 1, { hourPriceArs: 3900 });

      expect(mockTenant.entry.findMany).not.toHaveBeenCalled();
      expect(mockTenant.entry.updateMany).not.toHaveBeenCalled();
    });

    it('con el flag pero sin cambios de precio, no hace nada y no falla', async () => {
      // Un 400 acá mandaría a `failed` una operación encolada offline y
      // dejaría un pendiente que nadie puede destrabar.
      tarifaEditada();

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateRate('r-1', 1, {
          name: 'OTRO NOMBRE',
          applyToOpenEntries: true,
        }),
      ).resolves.toBeDefined();

      expect(mockTenant.entry.updateMany).not.toHaveBeenCalled();
    });

    it('sin autos adentro no escribe ni una fila de auditoría', async () => {
      tarifaEditada();
      mockTenant.entry.findMany.mockResolvedValue([]);

      await service.updateRate('r-1', 1, {
        hourPriceArs: 3900,
        applyToOpenEntries: true,
      });

      expect(mockTenant.entry.updateMany).not.toHaveBeenCalled();
      expect(mockTenant.auditLog.create).not.toHaveBeenCalled();
    });

    it('una version vieja no propaga nada', async () => {
      // El chequeo de versión corre primero, dentro de la misma transacción.
      mockTenant.rate.findFirst.mockResolvedValue(makeRate());
      mockTenant.rate.updateMany.mockResolvedValue({ count: 0 });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateRate('r-1', 99, {
          hourPriceArs: 3900,
          applyToOpenEntries: true,
        }),
      ).rejects.toBeInstanceOf(FormattedException);

      expect(mockTenant.entry.updateMany).not.toHaveBeenCalled();
    });

    it('audita con el conteo real y los precios de antes y después', async () => {
      tarifaEditada();
      mockTenant.entry.findMany.mockResolvedValue(abiertas);
      mockTenant.entry.updateMany.mockResolvedValue({ count: 2 });

      await service.updateRate('r-1', 1, {
        hourPriceArs: 3900,
        applyToOpenEntries: true,
      });

      const [args] = mockTenant.auditLog.create.mock.calls[0] as [
        {
          data: {
            action: string;
            severity: string;
            metadata: Record<string, unknown>;
          };
        },
      ];
      expect(args.data.action).toBe('rate.prices_propagated');
      expect(args.data.severity).toBe('warn');
      expect(args.data.metadata.affectedCount).toBe(2);
      expect(args.data.metadata.before).toMatchObject({ hour: '1000' });
      expect(args.data.metadata.after).toMatchObject({ hour: '3900' });
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
