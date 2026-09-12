import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { AuditActions } from '../audit/audit.service';
import { EntriesService } from './entries.service';

describe('EntriesService', () => {
  let service: EntriesService;
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const ENTRY = '22222222-2222-7222-8222-222222222222';
  const USER = {
    id: '33333333-3333-7333-8333-333333333333',
    email: 'operator@parkit.test',
    role: 'user',
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function exceptionDetail(error: unknown): string | null {
    if (!isRecord(error)) return null;
    const getResponse = error.getResponse;
    if (typeof getResponse !== 'function') return null;
    const response = getResponse.call(error) as unknown;
    if (!isRecord(response)) return null;
    const detail = response.detail;
    return typeof detail === 'string' ? detail : null;
  }

  async function expectRejectDetail(
    promise: Promise<unknown>,
    detailFragment: string,
  ): Promise<void> {
    try {
      await promise;
      throw new Error('Expected promise to reject');
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message === 'Expected promise to reject'
      ) {
        throw error;
      }
      expect(exceptionDetail(error)).toContain(detailFragment);
    }
  }

  const mockTenant = {
    entry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockPrisma = {
    // Simulamos el método getTenantClient
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntriesService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        // `EntriesService` lo inyecta para resolver el tenant activo desde el
        // AsyncLocalStorage. Sin registrarlo, Nest no puede construir el
        // service y el `beforeEach` explota antes del primer `it`.
        TenantContextService,
      ],
    }).compile();

    service = module.get<EntriesService>(EntriesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should call prisma with the correct tenant isolation', async () => {
      const mockEntries = [{ id: '1', plate: 'AAA111' }];

      // Mockeamos el valor de retorno del findMany dentro de tenant.
      //
      // Antes esto casteaba a `jest.Mock`, que no existe: acá corre
      // `bun test`. Bun shimea `jest` como VALOR (por eso `jest.fn()` anda
      // más arriba), pero no publica el namespace de TIPOS. Era un error de
      // TS invisible, porque `nest build` excluye los specs y `bun test` no
      // chequea tipos. Sin el cast, `jest.fn()` ya tipa bien el mock.
      mockTenant.entry.findMany.mockResolvedValue(mockEntries);

      const result = await service.findAll();

      // `findAll` mapea por `toDto`, así que el resultado NO es la fila cruda:
      // es el DTO completo con el resto de los campos en undefined. Se asertan
      // los campos que sí viajan, no la identidad del objeto.
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: '1', plate: 'AAA111' });

      // Lo que este test cuida de verdad: el aislamiento por tenant.
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.entry.findMany).toHaveBeenCalledWith({
        orderBy: [{ enteredAt: 'desc' }],
      });
    });
  });

  describe('correctEntry', () => {
    function makeEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: ENTRY,
        tenantId: TENANT,
        plate: 'ABC123',
        color: 'Rojo',
        cochera: 'A1',
        notes: 'Original',
        enteredAt: new Date('2026-09-08T10:00:00.000Z'),
        leftAt: new Date('2026-09-08T12:00:00.000Z'),
        amountPaid: 2000,
        vehicleBrand: 'Ford',
        vehicleModel: 'Focus',
        rateId: '44444444-4444-7444-8444-444444444444',
        rateSnapshotName: 'Auto',
        rateSnapshotHourPriceArs: 1000,
        rateSnapshotStayPriceArs: 5000,
        rateSnapshotFractionPriceArs: 500,
        cashSessionId: '55555555-5555-7555-8555-555555555555',
        ticketNumber: 7,
        version: 2,
        syncSeq: 9,
        updatedAt: new Date('2026-09-08T12:00:00.000Z'),
        cashSession: {
          id: '55555555-5555-7555-8555-555555555555',
          closedAt: null,
        },
        paymentTransactions: [
          {
            id: '66666666-6666-7666-8666-666666666666',
            paymentMethodId: '77777777-7777-7777-8777-777777777777',
            paymentMethodName: 'Efectivo',
            amount: 2000,
            deletedAt: null,
          },
        ],
        ...overrides,
      };
    }

    function makeService(current: Record<string, unknown>) {
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(current),
          update: jest.fn().mockResolvedValue(undefined),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            ...current,
            plate: 'XYZ999',
            version: 3,
          }),
        },
        paymentTransaction: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue(undefined),
        },
      };
      const prisma = {
        $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
      };
      const tenantContext = { getTenantIdOrThrow: () => TENANT };
      return {
        tx,
        service: new EntriesService(
          prisma as unknown as PrismaService,
          tenantContext as unknown as TenantContextService,
        ),
      };
    }

    it('corrige una entrada y registra before/after en auditoria', async () => {
      const { service: subject, tx } = makeService(makeEntry());

      await subject.correctEntry(
        ENTRY,
        2,
        { plate: 'xyz999' },
        USER as never,
        { role: 'owner' } as never,
      );

      const updateArg = tx.entry.update.mock.calls[0][0] as {
        data: { plate?: string };
      };
      expect(updateArg.data.plate).toBe('XYZ999');

      const auditArg = tx.auditLog.create.mock.calls[0][0] as {
        data: {
          action: string;
          metadata: {
            before: { plate: string };
            after: { plate: string };
            changedFields: string[];
          };
        };
      };
      expect(auditArg.data.action).toBe(AuditActions.ENTRY_CORRECTED);
      expect(auditArg.data.metadata.before.plate).toBe('ABC123');
      expect(auditArg.data.metadata.after.plate).toBe('XYZ999');
      expect(auditArg.data.metadata.changedFields).toContain('plate');
    });

    it('rechaza cualquier correccion de una caja cerrada', async () => {
      const { service: subject } = makeService(
        makeEntry({
          cashSession: {
            id: '55555555-5555-7555-8555-555555555555',
            closedAt: new Date(),
          },
        }),
      );

      await expectRejectDetail(
        subject.correctEntry(ENTRY, 2, { plate: 'XYZ999' }, USER as never),
        'closed cash session',
      );
    });

    it('rechaza pagos o egreso en entradas activas', async () => {
      const { service: subject } = makeService(
        makeEntry({ leftAt: null, amountPaid: null, paymentTransactions: [] }),
      );

      await expectRejectDetail(
        subject.correctEntry(
          ENTRY,
          2,
          {
            payments: [
              {
                id: '88888888-8888-7888-8888-888888888888',
                paymentMethodName: 'Efectivo',
                amount: 100,
              },
            ],
          },
          USER as never,
        ),
        'Active entries',
      );
    });

    it('rechaza egreso igual o anterior al ingreso', async () => {
      const { service: subject } = makeService(makeEntry());

      await expectRejectDetail(
        subject.correctEntry(
          ENTRY,
          2,
          { leftAt: '2026-09-08T10:00:00.000Z' },
          USER as never,
          { role: 'owner' } as never,
        ),
        'after entry',
      );
    });

    it('permite corregir horarios o tarifa aunque el cobro no coincida con el sugerido', async () => {
      const { service: subject, tx } = makeService(makeEntry());
      tx.entry.findUniqueOrThrow.mockResolvedValueOnce({
        ...makeEntry(),
        leftAt: new Date('2026-09-08T13:00:00.000Z'),
        rateSnapshotName: 'Auto corregida',
        version: 3,
      });

      await subject.correctEntry(
        ENTRY,
        2,
        {
          leftAt: '2026-09-08T13:00:00.000Z',
          rateSnapshotName: 'Auto corregida',
        },
        USER as never,
        { role: 'owner' } as never,
      );

      const updateArg = tx.entry.update.mock.calls[0][0] as {
        data: { leftAt?: Date; rateSnapshotName?: string };
      };
      expect(updateArg.data.leftAt?.toISOString()).toBe(
        '2026-09-08T13:00:00.000Z',
      );
      expect(updateArg.data.rateSnapshotName).toBe('Auto corregida');

      const auditArg = tx.auditLog.create.mock.calls[0][0] as {
        data: {
          metadata: {
            economicImpact: {
              suggestedBefore: number;
              suggestedAfter: number;
              suggestedDelta: number;
              chargedBefore: number;
              chargedAfter: number;
              chargedDelta: number;
              deltaVsSuggestedAfter: number;
            };
          };
        };
      };
      expect(auditArg.data.metadata.economicImpact).toMatchObject({
        suggestedBefore: 2000,
        suggestedAfter: 3000,
        suggestedDelta: 1000,
        chargedBefore: 2000,
        chargedAfter: 2000,
        chargedDelta: 0,
        deltaVsSuggestedAfter: 1000,
      });
    });

    it('exige razon si un operador cambia horarios o montos', async () => {
      const { service: subject } = makeService(makeEntry());

      await expectRejectDetail(
        subject.correctEntry(
          ENTRY,
          2,
          { enteredAt: '2026-09-08T09:00:00.000Z' },
          USER as never,
          { role: 'operator' } as never,
        ),
        'reason is required',
      );
    });
  });

  describe('closeEntry', () => {
    it('registra anomalia si el cobro queda al menos 5% debajo del sugerido', async () => {
      const current = {
        id: ENTRY,
        tenantId: TENANT,
        plate: 'ABC123',
        enteredAt: new Date('2026-09-08T10:00:00.000Z'),
        leftAt: null,
        amountPaid: null,
        rateId: null,
        rateSnapshotName: 'Auto',
        rateSnapshotHourPriceArs: 1000,
        rateSnapshotStayPriceArs: 5000,
        rateSnapshotFractionPriceArs: 500,
        cashSessionId: '55555555-5555-7555-8555-555555555555',
        ticketNumber: 7,
      };
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(current),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            ...current,
            leftAt: new Date('2026-09-08T12:00:00.000Z'),
            amountPaid: 1800,
          }),
        },
        paymentTransaction: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      };
      const prisma = {
        $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
      };
      const tenantContext = { getTenantIdOrThrow: () => TENANT };
      const subject = new EntriesService(
        prisma as unknown as PrismaService,
        tenantContext as unknown as TenantContextService,
      );

      await subject.closeEntry(
        ENTRY,
        1,
        {
          leftAt: '2026-09-08T12:00:00.000Z',
          amountPaid: 1800,
        },
        USER as never,
        { role: 'operator' } as never,
      );

      const auditArg = tx.auditLog.create.mock.calls[0][0] as {
        data: {
          action: string;
          metadata: {
            suggestedAmount: number;
            chargedAmount: number;
          };
        };
      };
      expect(auditArg.data.action).toBe(AuditActions.ENTRY_UNDERCHARGED);
      expect(auditArg.data.metadata.suggestedAmount).toBe(2000);
      expect(auditArg.data.metadata.chargedAmount).toBe(1800);
    });
  });
});
