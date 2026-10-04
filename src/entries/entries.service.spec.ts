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

    it('no registra auditoría cuando sólo cambian notas o color', async () => {
      const current = makeEntry();
      const { service: subject, tx } = makeService(current);
      tx.entry.findUniqueOrThrow.mockResolvedValue({
        ...current,
        color: 'Azul',
        notes: 'Nota interna actualizada',
        version: 3,
      });

      await subject.correctEntry(
        ENTRY,
        2,
        { color: 'Azul', notes: 'Nota interna actualizada' },
        USER as never,
        { role: 'owner' } as never,
      );

      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('registra auditoría si color o notas vienen junto con un campo auditable', async () => {
      const current = makeEntry();
      const { service: subject, tx } = makeService(current);
      tx.entry.findUniqueOrThrow.mockResolvedValue({
        ...current,
        plate: 'XYZ999',
        color: 'Azul',
        version: 3,
      });

      await subject.correctEntry(
        ENTRY,
        2,
        { plate: 'xyz999', color: 'Azul' },
        USER as never,
        { role: 'owner' } as never,
      );

      const auditArg = tx.auditLog.create.mock.calls[0][0] as {
        data: { metadata: { changedFields: string[] } };
      };
      expect(auditArg.data.metadata.changedFields).toEqual(['plate', 'color']);
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

    it('marcar «Facturada» a mano se permite aunque la caja esté cerrada', async () => {
      const { service: subject, tx } = makeService(
        makeEntry({
          cashSession: {
            id: '55555555-5555-7555-8555-555555555555',
            closedAt: new Date(),
          },
        }),
      );

      await subject.correctEntry(
        ENTRY,
        2,
        { manuallyInvoiced: true },
        USER as never,
      );

      const updateArg = tx.entry.update.mock.calls[0][0] as {
        data: { manuallyInvoiced?: boolean };
      };
      expect(updateArg.data.manuallyInvoiced).toBe(true);
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

    /**
     * Cableado del snapshot de media estadía hasta el detector de subcobro.
     *
     * El motor está testeado aparte en `pricing.spec.ts`; lo que prueba esto es
     * que el campo VIAJA: que el tope de 12h congelado al ingreso llega al
     * cálculo. Si alguien se olvida de propagarlo en `registerExit`, el sugerido
     * sube por encima del tope y el operador que cobró bien queda marcado como
     * subcobrador en Auditoría.
     */
    it('respeta el tope de media estadía del snapshot al medir el subcobro', async () => {
      const current = {
        id: ENTRY,
        tenantId: TENANT,
        plate: 'ABC123',
        enteredAt: new Date('2026-09-08T10:00:00.000Z'),
        leftAt: null,
        amountPaid: null,
        rateId: null,
        rateSnapshotName: 'Auto',
        rateSnapshotHourPriceArs: 4000,
        rateSnapshotStayPriceArs: 18000,
        rateSnapshotFractionPriceArs: 400,
        rateSnapshotMediaEstadiaPriceArs: 12000,
        cashSessionId: '55555555-5555-7555-8555-555555555555',
        ticketNumber: 7,
      };
      // 6 horas. Sin el tope el sugerido sería 24.000; con el tope, 12.000.
      const leftAt = new Date('2026-09-08T16:00:00.000Z');
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(current),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            ...current,
            leftAt,
            amountPaid: 5000,
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
        { leftAt: leftAt.toISOString(), amountPaid: 5000 },
        USER as never,
        { role: 'operator' } as never,
      );

      const auditArg = tx.auditLog.create.mock.calls[0][0] as {
        data: { metadata: { suggestedAmount: number } };
      };
      expect(auditArg.data.metadata.suggestedAmount).toBe(12000);
    });
  });

  /**
   * EL SNAPSHOT DEL TIPO DE MEDIO DE PAGO — camino del dinero.
   *
   * `payment_transactions.payment_method_type` es lo que el arqueo de caja del
   * desktop mira para decidir qué plata entró al cajón. Si el backend lo
   * escribe mal, el operador cierra el turno con un faltante que no existe (o
   * sin uno que sí).
   *
   * El fix anterior de este mismo bug (renombrar los métodos del sistema a
   * español) se mergeó SIN un test que avisara si volvía. Este bloque es esa
   * red: cubre las tres ramas de precedencia y, sobre todo, el caso que rompía
   * antes — el método renombrado a algo que no dice "efectivo".
   */
  describe('snapshot del tipo de medio de pago al cobrar', () => {
    const CASH_PM = '77777777-7777-7777-8777-777777777777';
    const OTHER_PM = '99999999-9999-7999-8999-999999999999';

    function makeCloseService(paymentMethods: unknown[] = []) {
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
            amountPaid: 2000,
          }),
        },
        paymentMethod: {
          findMany: jest.fn().mockResolvedValue(paymentMethods),
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
      return {
        tx,
        service: new EntriesService(
          prisma as unknown as PrismaService,
          tenantContext as unknown as TenantContextService,
        ),
      };
    }

    async function close(
      subject: EntriesService,
      payments: Record<string, unknown>[],
    ): Promise<void> {
      await subject.closeEntry(
        ENTRY,
        1,
        {
          leftAt: '2026-09-08T12:00:00.000Z',
          cashSessionId: '55555555-5555-7555-8555-555555555555',
          payments: payments as never,
        },
        USER as never,
        { role: 'operator' } as never,
      );
    }

    function writtenRows(tx: {
      paymentTransaction: { createMany: { mock: { calls: unknown[][] } } };
    }): Array<{ paymentMethodName: string; paymentMethodType: string }> {
      const call = tx.paymentTransaction.createMany.mock.calls[0][0] as {
        data: Array<{ paymentMethodName: string; paymentMethodType: string }>;
      };
      return call.data;
    }

    it('escribe el tipo que mandó el cliente, que es el snapshot', async () => {
      const { service: subject, tx } = makeCloseService();

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodId: CASH_PM,
          paymentMethodName: 'Efectivo',
          paymentMethodType: 'cash',
          amount: 2000,
        },
      ]);

      expect(writtenRows(tx)[0].paymentMethodType).toBe('cash');
      // Si el cliente ya mandó el tipo, no hace falta ir a la base.
      expect(tx.paymentMethod.findMany).not.toHaveBeenCalled();
    });

    it('ESTE es el bug: un método de efectivo renombrado a "Caja" se sigue contando como efectivo', async () => {
      // El dueño renombró su método de efectivo. `'caja'.includes('efectivo')`
      // es false, así que con la regla vieja esta plata desaparecía del arqueo
      // y le aparecía al operador como faltante.
      const { service: subject, tx } = makeCloseService();

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodId: CASH_PM,
          paymentMethodName: 'Caja',
          paymentMethodType: 'cash',
          amount: 2000,
        },
      ]);

      expect(writtenRows(tx)[0]).toMatchObject({
        paymentMethodName: 'Caja',
        paymentMethodType: 'cash',
      });
    });

    it('la otra mitad del bug: un "Efectivo Mercado Pago" type=other NO es efectivo', async () => {
      // La plata entró por MP, no al cajón. Con la regla vieja el arqueo se lo
      // reclamaba al operador.
      const { service: subject, tx } = makeCloseService();

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodId: OTHER_PM,
          paymentMethodName: 'Efectivo Mercado Pago',
          paymentMethodType: 'other',
          amount: 2000,
        },
      ]);

      expect(writtenRows(tx)[0]).toMatchObject({
        paymentMethodName: 'Efectivo Mercado Pago',
        paymentMethodType: 'other',
      });
    });

    it('cliente viejo sin tipo: lo resuelve por id contra payment_methods', async () => {
      // Un desktop que todavía no se actualizó no manda el tipo, pero sí manda
      // el id. Ahí la base tiene la respuesta exacta, y el nombre no importa.
      const { service: subject, tx } = makeCloseService([
        { id: CASH_PM, type: 'cash' },
      ]);

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodId: CASH_PM,
          paymentMethodName: 'Caja',
          amount: 2000,
        },
      ]);

      expect(tx.paymentMethod.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT, id: { in: [CASH_PM] } },
        select: { id: true, type: true },
      });
      expect(writtenRows(tx)[0].paymentMethodType).toBe('cash');
    });

    it('cliente viejo y método ya borrado: recién ahí infiere del nombre', async () => {
      // Último recurso. `findMany` no devuelve nada porque el método no existe
      // más (la columna no tiene FK justamente para permitir eso).
      const { service: subject, tx } = makeCloseService([]);

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodId: OTHER_PM,
          paymentMethodName: 'Efectivo',
          amount: 1000,
        },
        {
          id: '88888888-8888-7888-8888-888888888889',
          paymentMethodName: 'Transferencia Galicia',
          amount: 1000,
        },
      ]);

      const rows = writtenRows(tx);
      expect(rows[0].paymentMethodType).toBe('cash');
      expect(rows[1].paymentMethodType).toBe('transfer');
    });

    it('nunca escribe una fila sin tipo: la columna es NOT NULL', async () => {
      // Sin esto un pago se perdería con un error de constraint en producción.
      const { service: subject, tx } = makeCloseService([]);

      await close(subject, [
        {
          id: '88888888-8888-7888-8888-888888888888',
          paymentMethodName: 'Lo que sea',
          amount: 500,
        },
      ]);

      for (const row of writtenRows(tx)) {
        expect(row.paymentMethodType).toBeDefined();
      }
    });
  });

  /**
   * EL CONSUMO DEL PAYMENT INTENT (B5) — la parte de más riesgo del cierre.
   *
   * `closeEntry` es el camino de cobro de TODAS las playas, incluidas las que
   * no tocan Mercado Pago. Estos cinco casos cubren las dos cosas que hay que
   * garantizar: que el intento aprobado se queme UNA sola vez y bajo las cinco
   * guardas, y que el cierre en efectivo siga funcionando exactamente igual.
   *
   * El mock de `paymentIntent.updateMany` EVALÚA el `where` contra una fila
   * fixture en vez de devolver un `count` fijo. Es a propósito: si devolviera
   * `{ count: 0 }` a secas, los casos de "monto distinto" y "otra estadía"
   * serían el mismo test escrito tres veces y pasarían aunque alguien borrara
   * esas guardas del `where`. Acá, borrarlas los pone en rojo.
   */
  describe('consumo del payment intent al cerrar la estadia', () => {
    const INTENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    const LINE = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
    const OTHER_ENTRY = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
    const CASH_SESSION = '55555555-5555-7555-8555-555555555555';
    const AMOUNT = 5000;

    type IntentRow = {
      id: string;
      tenantId: string;
      entryId: string;
      status: string;
      amount: number;
    };
    type IntentWhere = {
      id?: string;
      tenantId?: string;
      entryId?: string;
      status?: string;
      amount?: { gte?: number; lte?: number };
    };

    function makeIntent(overrides: Partial<IntentRow> = {}): IntentRow {
      return {
        id: INTENT,
        tenantId: TENANT,
        entryId: ENTRY,
        status: 'approved',
        amount: AMOUNT,
        ...overrides,
      };
    }

    // El `WHERE` del `updateMany`, resuelto contra la fila. Si falta la guarda
    // de monto no se inventa una: el test que la cuida es el de "monto
    // distinto", y el feliz asserta el `where` completo aparte.
    function matches(where: IntentWhere, row: IntentRow): boolean {
      if (where.id !== row.id) return false;
      if (where.tenantId !== row.tenantId) return false;
      if (where.entryId !== row.entryId) return false;
      if (where.status !== row.status) return false;
      const { gte, lte } = where.amount ?? {};
      if (gte !== undefined && row.amount < gte) return false;
      if (lte !== undefined && row.amount > lte) return false;
      return true;
    }

    function makeCloseService(intent: IntentRow | null) {
      const current = {
        id: ENTRY,
        tenantId: TENANT,
        plate: 'ABC123',
        enteredAt: new Date('2026-09-08T10:00:00.000Z'),
        leftAt: null,
        amountPaid: null,
        rateId: null,
        rateSnapshotName: 'Auto',
        rateSnapshotHourPriceArs: 2500,
        rateSnapshotStayPriceArs: 20000,
        rateSnapshotFractionPriceArs: 500,
        cashSessionId: CASH_SESSION,
        ticketNumber: 7,
      };
      const state = { rolledBack: false };
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(current),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            ...current,
            leftAt: new Date('2026-09-08T12:00:00.000Z'),
            amountPaid: AMOUNT,
          }),
        },
        paymentMethod: { findMany: jest.fn().mockResolvedValue([]) },
        paymentTransaction: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        paymentIntent: {
          updateMany: jest.fn((args: { where: IntentWhere }) =>
            Promise.resolve({
              count: intent && matches(args.where, intent) ? 1 : 0,
            }),
          ),
        },
        auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      };
      const prisma = {
        // Modela el rollback: si el callback tira, Prisma aborta la
        // transacción entera. En un unit test con `tx` mockeado no hay base que
        // revierta, así que lo que se puede probar —y lo que importa— es que la
        // excepción ESCAPA del callback. Eso es exactamente lo que hace que el
        // `UPDATE entries` no commitee.
        $transaction: jest.fn(async (cb: (txArg: typeof tx) => unknown) => {
          try {
            return await cb(tx);
          } catch (error) {
            state.rolledBack = true;
            throw error;
          }
        }),
      };
      const tenantContext = { getTenantIdOrThrow: () => TENANT };
      return {
        tx,
        state,
        service: new EntriesService(
          prisma as unknown as PrismaService,
          tenantContext as unknown as TenantContextService,
        ),
      };
    }

    function close(
      subject: EntriesService,
      line: Record<string, unknown>,
    ): Promise<unknown> {
      return subject.closeEntry(
        ENTRY,
        1,
        {
          leftAt: '2026-09-08T12:00:00.000Z',
          cashSessionId: CASH_SESSION,
          payments: [line] as never,
        },
        USER as never,
        { role: 'operator' } as never,
      );
    }

    function qrLine(overrides: Record<string, unknown> = {}) {
      return {
        id: LINE,
        paymentMethodName: 'Mercado Pago QR',
        paymentMethodType: 'other',
        amount: AMOUNT,
        paymentIntentId: INTENT,
        ...overrides,
      };
    }

    it('quema el intento aprobado y cierra la estadia en la misma transaccion', async () => {
      const { service: subject, tx } = makeCloseService(makeIntent());

      await close(subject, qrLine());

      const call = tx.paymentIntent.updateMany.mock.calls[0][0] as {
        where: IntentWhere;
        data: {
          status: string;
          consumedAt: Date;
          paymentTransactionId: string;
        };
      };

      // Las cinco guardas viajan en la MISMA sentencia que el SET. El
      // `tenantId` explícito no es opcional: `payment_intents` NO está en
      // `TENANT_MODELS`, así que la extensión de Prisma no lo inyecta.
      expect(call.where).toMatchObject({
        id: INTENT,
        tenantId: TENANT,
        entryId: ENTRY,
        status: 'approved',
      });
      expect(call.where.amount?.gte).toBeLessThan(AMOUNT);
      expect(call.where.amount?.lte).toBeGreaterThan(AMOUNT);

      expect(call.data.status).toBe('consumed');
      expect(call.data.consumedAt.toISOString()).toBe(
        '2026-09-08T12:00:00.000Z',
      );
      // El id de la línea es el de la `payment_transaction` que se acaba de
      // insertar: lo genera el cliente (UUIDv7), no hace falta releer nada.
      expect(call.data.paymentTransactionId).toBe(LINE);
      expect(tx.entry.updateMany).toHaveBeenCalled();
    });

    it('doble consumo: un intento ya consumido da 409 y la estadia NO se cierra', async () => {
      const { service: subject, state } = makeCloseService(
        makeIntent({ status: 'consumed' }),
      );

      await expectRejectDetail(close(subject, qrLine()), 'cannot be consumed');
      // La excepción escapó del callback de `$transaction`: Prisma aborta y el
      // `UPDATE entries` nunca commitea. Sin esto, el mismo cobro se aplicaría
      // a dos estadías y el arqueo contaría dos veces una plata que entró una.
      expect(state.rolledBack).toBe(true);
    });

    it('monto distinto del de la linea: 409', async () => {
      // Fuera del epsilon (medio centavo), no un centavo de redondeo.
      const { service: subject, state } = makeCloseService(
        makeIntent({ amount: AMOUNT + 1000 }),
      );

      await expectRejectDetail(close(subject, qrLine()), 'cannot be consumed');
      expect(state.rolledBack).toBe(true);
    });

    it('intento de OTRA estadia: 409', async () => {
      const { service: subject, state } = makeCloseService(
        makeIntent({ entryId: OTHER_ENTRY }),
      );

      await expectRejectDetail(close(subject, qrLine()), 'cannot be consumed');
      expect(state.rolledBack).toBe(true);
    });

    /**
     * EL TEST MÁS IMPORTANTE DE LOS CINCO.
     *
     * El 99% de los cierres son en efectivo y vienen de playas que no tienen
     * Mercado Pago vinculado. Si B5 les agrega una query, un 409 o cualquier
     * cambio de comportamiento, la regresión no es de la integración nueva: es
     * del cobro de todo el negocio.
     */
    it('cierre normal en efectivo, sin paymentIntentId: intacto', async () => {
      const { service: subject, tx } = makeCloseService(null);

      await close(subject, {
        id: LINE,
        paymentMethodName: 'Efectivo',
        paymentMethodType: 'cash',
        amount: AMOUNT,
      });

      // Ni una query de más contra `payment_intents`.
      expect(tx.paymentIntent.updateMany).not.toHaveBeenCalled();
      expect(tx.entry.updateMany).toHaveBeenCalled();

      const rows = (
        tx.paymentTransaction.createMany.mock.calls[0][0] as {
          data: Array<{
            id: string;
            amount: number;
            paymentMethodType: string;
          }>;
        }
      ).data;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: LINE,
        amount: AMOUNT,
        paymentMethodType: 'cash',
      });
    });
  });

  describe('tipo y categoría del vehículo', () => {
    const TYPE_ID = '88888888-8888-7888-8888-888888888888';

    function setup(vehicleType: unknown = null) {
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({
                ...data,
                enteredAt: new Date('2026-10-01T10:00:00.000Z'),
                updatedAt: new Date('2026-10-01T10:00:00.000Z'),
                version: 1,
                syncSeq: 1,
              }),
            ),
        },
        vehicleType: { findFirst: jest.fn().mockResolvedValue(vehicleType) },
        whitelist: { findFirst: jest.fn().mockResolvedValue(null) },
        // Sin reservas para la patente: el ingreso queda sin vincular.
        reservation: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn(),
        },
      };
      const prisma = {
        $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
      };
      const subject = new EntriesService(
        prisma as unknown as PrismaService,
        { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
      );
      return { tx, subject };
    }

    const baseCreate = {
      id: ENTRY,
      plate: 'abc123',
      enteredAt: '2026-10-01T10:00:00.000Z',
    };

    it('ingreso manual con vehicleTypeId: guarda id, nombre y categoría del tipo', async () => {
      const { tx, subject } = setup({
        id: TYPE_ID,
        name: 'Autos',
        category: 'car',
      });

      const dto = await subject.createEntry({
        ...baseCreate,
        vehicleTypeId: TYPE_ID,
      });

      const { data } = tx.entry.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        vehicleTypeId: TYPE_ID,
        vehicleType: 'Autos',
        vehicleCategory: 'car',
      });
      // El tipo se busca en el tenant del contexto, nunca por el id solo.
      expect(tx.vehicleType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TYPE_ID, tenantId: TENANT } }),
      );
      expect(dto).toMatchObject({
        vehicleTypeId: TYPE_ID,
        vehicleType: 'Autos',
        vehicleCategory: 'car',
      });
    });

    it('caja vieja: sin tipo ni categoría el ingreso queda con todo en null', async () => {
      const { tx, subject } = setup();

      const dto = await subject.createEntry(baseCreate);

      expect(tx.vehicleType.findFirst).not.toHaveBeenCalled();
      expect(dto).toMatchObject({
        vehicleType: null,
        vehicleTypeId: null,
        vehicleCategory: null,
      });
    });

    it('tipo inexistente o de otro tenant: no falla y usa la categoría del cliente', async () => {
      const { tx, subject } = setup(null);

      await subject.createEntry({
        ...baseCreate,
        vehicleTypeId: TYPE_ID,
        vehicleCategory: 'motorcycle',
      });

      const { data } = tx.entry.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        vehicleTypeId: null,
        vehicleType: null,
        vehicleCategory: 'motorcycle',
      });
    });

    it('LPR: resuelve el tipo por el nombre que manda la cámara', async () => {
      const { tx, subject } = setup({
        id: TYPE_ID,
        name: 'Pick-up',
        category: 'pickup',
      });

      await subject.createStayFromLprEvent({
        plate: 'ABC123',
        vehicleType: 'pick-up',
      });

      const { data } = tx.entry.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        source: 'auto',
        vehicleTypeId: TYPE_ID,
        vehicleType: 'Pick-up',
        vehicleCategory: 'pickup',
      });
    });

    it('LPR sin tipo: queda en null, como antes', async () => {
      const { tx, subject } = setup();

      await subject.createStayFromLprEvent({ plate: 'ABC123' });

      const { data } = tx.entry.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        vehicleType: null,
        vehicleTypeId: null,
        vehicleCategory: null,
      });
    });

    it('corregir el tipo actualiza los tres campos y queda en la auditoría', async () => {
      const current = {
        id: ENTRY,
        tenantId: TENANT,
        plate: 'ABC123',
        color: null,
        cochera: null,
        notes: null,
        enteredAt: new Date('2026-09-08T10:00:00.000Z'),
        leftAt: null,
        amountPaid: null,
        vehicleBrand: null,
        vehicleModel: null,
        vehicleType: null,
        vehicleTypeId: null,
        vehicleCategory: null,
        rateId: null,
        ticketNumber: null,
        manuallyInvoiced: false,
        version: 2,
        syncSeq: 9,
        updatedAt: new Date('2026-09-08T12:00:00.000Z'),
        cashSession: null,
        paymentTransactions: [],
      };
      const tx = {
        entry: {
          findFirst: jest.fn().mockResolvedValue(current),
          update: jest.fn().mockResolvedValue(undefined),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            ...current,
            vehicleType: 'Autos',
            vehicleTypeId: TYPE_ID,
            vehicleCategory: 'car',
            version: 3,
          }),
        },
        vehicleType: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: TYPE_ID, name: 'Autos', category: 'car' }),
        },
        paymentTransaction: { updateMany: jest.fn(), createMany: jest.fn() },
        auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      };
      const subject = new EntriesService(
        {
          $transaction: jest.fn((cb: (txArg: typeof tx) => unknown) => cb(tx)),
        } as unknown as PrismaService,
        { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
      );

      await subject.correctEntry(
        ENTRY,
        2,
        { vehicleTypeId: TYPE_ID },
        USER as never,
        { role: 'owner' } as never,
      );

      const { data } = tx.entry.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        vehicleTypeId: TYPE_ID,
        vehicleType: 'Autos',
        vehicleCategory: 'car',
      });
      const audit = tx.auditLog.create.mock.calls[0][0] as {
        data: { metadata: { changedFields: string[] } };
      };
      const changed = audit.data.metadata.changedFields;
      expect(changed).toContain('vehicleType');
      expect(changed).toContain('vehicleTypeId');
      expect(changed).toContain('vehicleCategory');
    });
  });
});
