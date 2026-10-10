/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- el Prisma en memoria
   guarda filas sin tipar y los tests leen campos sueltos. */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import type { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { ArcaUnavailableError } from './arca.gateway';
import { FakeArcaGateway } from './fake-arca.gateway';
import {
  InvoiceReceiversService,
  PADRON_CACHE_TTL_MS,
} from './invoice-receivers.service';
import { InvoicesService, STALE_ISSUING_MS } from './invoices.service';
import { PermissionsService } from '../auth/permissions.service';
import { EntriesService } from '../entries/entries.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY = '22222222-2222-7222-8222-222222222222';
const CASH = '33333333-3333-7333-8333-333333333333';

type Row = Record<string, any>;
type Cond = { in?: unknown[]; lt?: Date; not?: unknown; increment?: number };

/** Matchea el subconjunto de `where` de Prisma que usa `InvoicesService`. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, raw]) => {
    if (key === 'OR') return (raw as Row[]).some((c) => matches(row, c));
    const value: unknown = row[key];
    if (raw !== null && typeof raw === 'object' && !(raw instanceof Date)) {
      const cond = raw as Cond;
      if (cond.in) return cond.in.includes(value);
      if (cond.lt) return value instanceof Date && value < cond.lt;
      if ('not' in cond) return value !== cond.not;
    }
    return value === raw;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, raw] of Object.entries(data)) {
    const cond = raw as Cond | null;
    row[key] =
      cond && typeof cond === 'object' && cond.increment !== undefined
        ? (row[key] as number) + cond.increment
        : (raw as unknown);
  }
}

/** Captura el error de una promesa que se espera que falle. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba que la promesa fallara.');
}

function codeOf(error: unknown): string | undefined {
  return ((error as FormattedException).getResponse() as { code?: string })
    .code;
}

/** Prisma en memoria: sólo lo que la emisión toca. */
function memoryPrisma(state: {
  invoices: Row[];
  account: Row | null;
  additionalAccounts?: Row[];
  actorRole?: 'owner' | 'operator';
  receivers: Row[];
  entries: Row[];
}) {
  const byKey = (where: Row) =>
    state.receivers.find(
      (r) =>
        r.tenantId === where.tenantId_cuit.tenantId &&
        r.cuit === where.tenantId_cuit.cuit,
    );
  const invoiceReceiver = {
    findUnique: ({ where }: Row) => Promise.resolve(byKey(where) ?? null),
    upsert: ({ where, create, update }: Row) => {
      const row = byKey(where);
      if (row) applyData(row, update);
      else state.receivers.push({ ...create });
      return Promise.resolve(row ?? create);
    },
    findMany: ({ where, take }: Row) =>
      Promise.resolve(
        state.receivers
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.lastUsedAt &&
              (!where.cuit ||
                String(r.cuit).startsWith(String(where.cuit.startsWith))),
          )
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, take),
      ),
  };
  const invoice = {
    findFirst: ({ where }: Row) =>
      Promise.resolve(state.invoices.find((r) => matches(r, where)) ?? null),
    findFirstOrThrow: ({ where }: Row) => {
      const row = state.invoices.find((r) => matches(r, where));
      return row
        ? Promise.resolve({ ...row })
        : Promise.reject(new Error('nf'));
    },
    findUnique: ({ where }: Row) =>
      Promise.resolve(state.invoices.find((r) => matches(r, where)) ?? null),
    findUniqueOrThrow: ({ where }: Row) =>
      Promise.resolve({ ...state.invoices.find((r) => matches(r, where))! }),
    findMany: ({ where }: Row) =>
      Promise.resolve(
        state.invoices.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
    updateMany: ({ where, data }: Row) => {
      const rows = state.invoices.filter((r) => matches(r, where));
      rows.forEach((r) => applyData(r, data));
      return Promise.resolve({ count: rows.length });
    },
    update: ({ where, data }: Row) => {
      const row = state.invoices.find((r) => matches(r, where))!;
      applyData(row, data);
      return Promise.resolve({ ...row });
    },
    create: ({ data }: Row) => {
      const row: Row = {
        id: `inv-${state.invoices.length + 1}`,
        cbteNro: null,
        attempts: 0,
        issuingStartedAt: null,
      };
      applyData(row, data);
      state.invoices.push(row);
      return Promise.resolve(row);
    },
  };
  const prisma = {
    invoice,
    invoiceReceiver,
    arcaAccount: {
      findFirst: ({ where }: Row) =>
        Promise.resolve(
          [
            ...(state.account ? [state.account] : []),
            ...(state.additionalAccounts ?? []),
          ].find((row) => matches(row, where)) ?? null,
        ),
    },
    user: {
      findUnique: ({ where }: Row) =>
        Promise.resolve({ id: String(where.id), role: 'user' }),
    },
    userMembership: {
      findUnique: () => Promise.resolve({ role: state.actorRole ?? 'owner' }),
    },
    arcaRequest: { create: jest.fn().mockResolvedValue(undefined) },
    paymentMethod: {
      findMany: () => Promise.resolve([{ id: CASH, invoiceMode: 'auto' }]),
    },
    entry: {
      findFirst: ({ where }: Row) =>
        Promise.resolve(state.entries.find((r) => matches(r, where)) ?? null),
      findUniqueOrThrow: ({ where }: Row) =>
        Promise.resolve(state.entries.find((r) => matches(r, where))),
      update: ({ where, data }: Row) => {
        const row = state.entries.find((r) => matches(r, where))!;
        applyData(row, data);
        return Promise.resolve(row);
      },
    },
    paymentTransaction: {
      findMany: ({ where }: Row) =>
        Promise.resolve(
          state.entries
            .flatMap((entry) => entry.paymentTransactions as Row[])
            .filter((row) => matches(row, where)),
        ),
      updateMany: ({ where, data }: Row) => {
        const rows = state.entries
          .flatMap((entry) => entry.paymentTransactions as Row[])
          .filter((row) => matches(row, where));
        rows.forEach((row) => applyData(row, data));
        return Promise.resolve({ count: rows.length });
      },
      createMany: ({ data }: Row) => {
        for (const line of data as Row[]) {
          const entry = state.entries.find((row) => row.id === line.entryId)!;
          (entry.paymentTransactions as Row[]).push({
            ...line,
            deletedAt: null,
          });
        }
        return Promise.resolve({ count: (data as Row[]).length });
      },
    },
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return prisma;
}

function setup(
  condicionIva = 'responsable_inscripto',
  environment: 'homologacion' | 'produccion' = 'homologacion',
) {
  const env: Record<string, string> = {
    ARCA_ENV: environment,
    ARCA_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const config = new ArcaConfigService({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as unknown as ConfigService);
  config.onModuleInit();
  const crypto = new ArcaCryptoService(config);
  const key = crypto.encrypt('-----BEGIN PRIVATE KEY-----fake');

  const state = {
    invoices: [] as Row[],
    receivers: [] as Row[],
    entries: [
      {
        id: ENTRY,
        tenantId: TENANT,
        deletedAt: null,
        amountPaid: 1210,
        version: 1,
        paymentTransactions: [
          {
            id: 'payment-1',
            tenantId: TENANT,
            entryId: ENTRY,
            paymentMethodId: CASH,
            deletedAt: null,
            amount: 1210,
          },
        ],
        cashSession: { closedAt: null },
        rateSnapshotHourPriceArs: null,
        rateSnapshotStayPriceArs: null,
        rateSnapshotFractionPriceArs: null,
        rateSnapshotMediaEstadiaPriceArs: null,
        enteredAt: new Date('2026-09-24T13:00:00.000Z'),
        leftAt: new Date('2026-09-24T15:30:00.000Z'),
      },
    ] as Row[],
    account: {
      id: 'primary-account',
      role: 'primary',
      tenantId: TENANT,
      environment,
      status: 'linked',
      cuit: '20447275865',
      ptoVta: 1,
      certPem: 'CERT',
      keyEncrypted: key.ciphertext,
      keyVersion: key.keyVersion,
      certFingerprint: 'abc',
      certExpiresAt: new Date(Date.now() + 86_400_000),
      condicionIva,
      ivaRate: 21,
      razonSocial: 'DE LA CRUZ JUAN MARTIN',
      domicilioFiscal: 'Calle 123, CABA',
      iibb: '901-000000-0',
      inicioActividad: null,
    } as Row | null,
    additionalAccounts: [] as Row[],
    actorRole: 'owner' as 'owner' | 'operator',
  };
  const prisma = memoryPrisma(state);
  const gateway = new FakeArcaGateway();
  const tenantContext = {
    getTenantIdOrThrow: () => TENANT,
  } as unknown as TenantContextService;
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    tenantContext,
    config,
    crypto,
    new InvoiceReceiversService(prisma as unknown as PrismaService),
    gateway,
    new PermissionsService(),
  );
  return { service, state, gateway, prisma };
}

function pendingInvoice(
  state: { invoices: Row[]; entries: Row[] },
  extra: Row = {},
): Row {
  const row = {
    id: `inv-${state.invoices.length + 1}`,
    tenantId: TENANT,
    entryId: ENTRY,
    status: 'pending',
    arcaAccountId: 'primary-account',
    impTotal: 1210,
    attempts: 0,
    cbteNro: null,
    issuingStartedAt: null,
    errorCode: null,
    errorMessage: null,
    ...extra,
  };
  state.invoices.push(row);
  if (!state.entries.some((entry) => entry.id === row.entryId)) {
    state.entries.push({ ...state.entries[0], id: row.entryId });
  }
  const entry = state.entries.find((entry) => entry.id === row.entryId)!;
  entry.amountPaid = row.impTotal;
  return row;
}

describe('InvoicesService', () => {
  describe('cuentas primaria y secundaria', () => {
    it('un lote sin selección nueva conserva el emisor de una factura pendiente', async () => {
      const { service, gateway } = twoAccounts();
      gateway.willRespond('reject', 'approve');
      await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      const result = await service.issueBatch([ENTRY], 'owner');
      expect(result.results[0].invoice?.arcaAccountId).toBe(
        'secondary-account',
      );
      expect(result.results[0].invoice?.status).toBe('issued');
    });
    function twoAccounts() {
      const context = setup();
      context.state.additionalAccounts.push({
        ...context.state.account!,
        id: 'secondary-account',
        role: 'secondary',
        cuit: '20123456786',
        ptoVta: 2,
        condicionIva: 'monotributo',
        razonSocial: 'Emisor secundario',
      });
      return context;
    }

    it('sin selección usa primaria; una selección del dueño usa sus datos fiscales', async () => {
      const { service, state, gateway } = twoAccounts();
      const calls = jest.spyOn(gateway, 'createVoucher');
      const result = await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      expect(result.arcaAccountId).toBe('secondary-account');
      expect(result.emisorRazonSocial).toBe('Emisor secundario');
      expect(gateway.createCalls[0]).toMatchObject({
        PtoVta: 2,
        CbteTipo: 11,
        ImpTotal: 1210,
      });
      expect(calls.mock.calls[0][0].cuit).toBe(
        state.additionalAccounts[0].cuit,
      );
      const primary = setup();
      expect((await primary.service.issueForEntry(ENTRY)).arcaAccountId).toBe(
        'primary-account',
      );
    });

    it('operador no puede emitir ni consultar el receptor con secundaria', async () => {
      const { service, state, gateway } = twoAccounts();
      state.actorRole = 'operator';
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(
              ENTRY,
              'operator',
              undefined,
              undefined,
              undefined,
              'secondary-account',
            ),
          ),
        ),
      ).toBe('ENTITY_INSUFFICIENT_ROLE');
      expect(
        codeOf(
          await rejection(
            service.lookupTaxpayer(
              '20447275865',
              'secondary-account',
              'operator',
            ),
          ),
        ),
      ).toBe('ENTITY_INSUFFICIENT_ROLE');
      expect(state.invoices).toHaveLength(0);
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('un rechazo conserva la cuenta para reintentar sin nueva selección', async () => {
      const { service, gateway } = twoAccounts();
      gateway.willRespond('reject', 'approve');
      await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      const result = await service.issueForEntry(ENTRY, 'owner');
      expect(result.status).toBe('issued');
      expect(result.arcaAccountId).toBe('secondary-account');
      expect(gateway.createCalls.every((call) => call.PtoVta === 2)).toBe(true);
    });

    it('una factura emitida conserva su estado aunque luego se desvincule la cuenta', async () => {
      const { service, state, gateway } = twoAccounts();
      await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      const issued = { ...state.invoices[0] };
      state.additionalAccounts[0].status = 'unlinked';

      const result = await service.issueAfterClose(issued.id, 'owner');

      expect(result?.status).toBe('issued');
      expect(result?.arcaAccountId).toBe('secondary-account');
      expect(state.invoices[0]).toEqual(issued);
      expect(gateway.createCalls).toHaveLength(1);
    });

    it('permite cambiar de cuenta después de un rechazo sin posible autorización', async () => {
      const { service, gateway } = twoAccounts();
      gateway.willRespond('reject', 'approve');
      await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      const result = await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'primary-account',
      );
      expect(result.arcaAccountId).toBe('primary-account');
      expect(gateway.createCalls[1].PtoVta).toBe(1);
    });

    it('una emisión incierta bloquea el cambio y se reconcilia con la cuenta original', async () => {
      const { service, state, gateway } = twoAccounts();
      gateway.willRespond('timeout-but-approved');
      await service.issueForEntry(
        ENTRY,
        'owner',
        undefined,
        1210,
        undefined,
        'secondary-account',
      );
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(
              ENTRY,
              'owner',
              undefined,
              1210,
              undefined,
              'primary-account',
            ),
          ),
        ),
      ).toBe('INVOICE_EMITTER_LOCKED');
      state.invoices[0].issuingStartedAt = new Date(
        Date.now() - STALE_ISSUING_MS - 1,
      );
      const result = await service.issueForEntry(ENTRY, 'owner');
      expect(result.status).toBe('issued');
      expect(result.arcaAccountId).toBe('secondary-account');
      expect(gateway.createCalls).toHaveLength(1);
    });

    it('no admite una cuenta de otro estacionamiento', async () => {
      const { service, state } = twoAccounts();
      state.additionalAccounts[0].tenantId = 'another-tenant';
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(
              ENTRY,
              'owner',
              undefined,
              undefined,
              undefined,
              'secondary-account',
            ),
          ),
        ),
      ).toBe('ARCA_ACCOUNT_UNAVAILABLE');
      expect(state.invoices).toHaveLength(0);
    });

    it('una cuenta desvinculada antes del sync deja pendiente y nunca usa primaria', async () => {
      const { service, state, prisma } = twoAccounts();
      state.additionalAccounts[0].status = 'unlinked';
      prisma.paymentMethod.findMany = () =>
        Promise.resolve([{ id: CASH, invoiceMode: 'none' }]);
      const result = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
        arcaAccountId: 'secondary-account',
        userId: 'owner',
      });
      expect(result?.issueNow).toBe(false);
      expect(state.invoices[0]).toMatchObject({
        status: 'pending',
        arcaAccountId: 'secondary-account',
        errorCode: 'ARCA_ACCOUNT_UNAVAILABLE',
      });
    });

    it('el lote conserva la cuenta seleccionada para todos los movimientos', async () => {
      const { service, state, gateway } = twoAccounts();
      state.entries.push({
        ...state.entries[0],
        id: 'entry-2',
        paymentTransactions: [
          {
            ...state.entries[0].paymentTransactions[0],
            id: 'payment-2',
            entryId: 'entry-2',
          },
        ],
      });
      const result = await service.issueBatch(
        [ENTRY, 'entry-2'],
        'owner',
        'secondary-account',
      );
      expect(
        result.results.every(
          (item) => item.invoice?.arcaAccountId === 'secondary-account',
        ),
      ).toBe(true);
      expect(gateway.createCalls).toHaveLength(2);
    });

    it('guarda el emisor externo y lo conserva después de desvincularlo', async () => {
      const { service, state, prisma } = twoAccounts();
      const entries = new EntriesService(
        prisma as never,
        { getTenantIdOrThrow: () => TENANT } as never,
        service,
      );
      await entries.correctEntry(
        ENTRY,
        1,
        {
          manuallyInvoiced: true,
          manualInvoiceType: 'C',
          manualInvoicePointOfSale: '2',
          manualInvoiceNumber: '42',
          manualInvoiceArcaAccountId: 'secondary-account',
        },
        { id: 'owner' } as never,
        { role: 'owner' } as never,
      );
      state.additionalAccounts[0].status = 'unlinked';
      expect(state.entries[0]).toMatchObject({
        manualInvoiceArcaAccountId: 'secondary-account',
        manualInvoiceIssuerName: 'Emisor secundario',
        manualInvoiceIssuerCuit: '20123456786',
      });
    });
  });
  describe('factura externa', () => {
    it('cierra una pendiente y bloquea vista previa, emisión individual y en lote', async () => {
      const { service, state, prisma, gateway } = setup();
      const invoice = pendingInvoice(state, {
        errorCode: 'ARCA_UNAVAILABLE',
        errorMessage: 'Sin conexión',
      });
      const entries = new EntriesService(
        prisma as unknown as PrismaService,
        { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
        service,
      );

      await entries.correctEntry(
        ENTRY,
        1,
        {
          manuallyInvoiced: true,
          manualInvoiceType: 'C',
          manualInvoicePointOfSale: '12',
          manualInvoiceNumber: '123',
        },
        { id: 'owner-user' } as never,
        { role: 'owner' } as never,
      );

      expect(state.entries[0].manuallyInvoiced).toBe(true);
      expect(invoice.status).toBe('not_required');
      expect(invoice.errorCode).toBeNull();
      expect(codeOf(await rejection(service.previewForEntry(ENTRY)))).toBe(
        'INVOICE_ALREADY_ISSUED',
      );
      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'INVOICE_ALREADY_ISSUED',
      );
      const batch = await service.issueBatch([ENTRY]);
      expect(batch.results[0].errorCode).toBe('INVOICE_ALREADY_ISSUED');
      expect(gateway.createCalls).toHaveLength(0);
    });

    it.each(['issued', 'issuing'])(
      'no reemplaza una factura de Parkit %s',
      async (status) => {
        const { service, state, prisma } = setup();
        pendingInvoice(state, { status });
        expect(
          codeOf(
            await rejection(
              service.markExternallyIssued(prisma as never, TENANT, ENTRY),
            ),
          ),
        ).toBe(
          status === 'issued'
            ? 'INVOICE_ALREADY_ISSUED'
            : 'INVOICE_IN_PROGRESS',
        );
        expect(state.invoices[0].status).toBe(status);
      },
    );
  });

  describe('importe confirmado', () => {
    it('regresion completa: cobrar 100, corregir pagos a 10 y enviar 10 a ARCA', async () => {
      const { service, state, prisma, gateway } = setup();
      pendingInvoice(state, { impTotal: 100 });
      const entry = state.entries[0];
      entry.paymentTransactions = [
        {
          id: 'old-payment',
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: CASH,
          paymentMethodName: 'Efectivo',
          amount: 100,
          deletedAt: null,
        },
      ];
      const entries = new EntriesService(
        prisma as unknown as PrismaService,
        { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
        service,
      );
      await entries.correctEntry(
        ENTRY,
        1,
        {
          payments: [
            {
              id: 'new-cash',
              paymentMethodId: CASH,
              paymentMethodName: 'Efectivo',
              paymentMethodType: 'cash',
              amount: 6.25,
            },
            {
              id: 'new-transfer',
              paymentMethodId: CASH,
              paymentMethodName: 'Transferencia',
              paymentMethodType: 'transfer',
              amount: 3.75,
            },
          ],
        },
        { id: 'owner', role: 'user' } as never,
        { role: 'owner' } as never,
      );
      expect(entry.amountPaid).toBe(10);
      expect(state.invoices[0].impTotal).toBe(10);
      expect(prisma.auditLog.create).toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalled();
      const preview = await service.previewForEntry(ENTRY);
      await service.issueForEntry(ENTRY, undefined, undefined, preview.amount);
      expect(gateway.createCalls[0].ImpTotal).toBe(10);
    });

    it.each(['issued', 'issuing'])(
      'no corrige pagos de una factura %s',
      async (status) => {
        const { service, state, prisma, gateway } = setup();
        pendingInvoice(state, { status, impTotal: 100 });
        state.entries[0].paymentTransactions = [
          {
            id: 'old-payment',
            tenantId: TENANT,
            entryId: ENTRY,
            paymentMethodName: 'Efectivo',
            amount: 100,
            deletedAt: null,
          },
        ];
        const entries = new EntriesService(
          prisma as unknown as PrismaService,
          {
            getTenantIdOrThrow: () => TENANT,
          } as unknown as TenantContextService,
          service,
        );
        expect(
          codeOf(
            await rejection(
              entries.correctEntry(
                ENTRY,
                1,
                {
                  payments: [
                    {
                      id: 'new-payment',
                      paymentMethodName: 'Efectivo',
                      paymentMethodType: 'cash',
                      amount: 10,
                    },
                  ],
                },
                { id: 'owner', role: 'user' } as never,
                { role: 'owner' } as never,
              ),
            ),
          ),
        ).toBe('INVOICE_ALREADY_ISSUED');
        expect(state.entries[0].amountPaid).toBe(100);
        expect(state.invoices[0].impTotal).toBe(100);
        expect(gateway.createCalls).toHaveLength(0);
      },
    );

    it.each(['pending', 'error', 'not_required'])(
      'repara un importe antiguo en estado %s: 100 -> 10',
      async (status) => {
        const { service, state, gateway } = setup();
        const invoice = pendingInvoice(state, { status, impTotal: 100 });
        state.entries[0].amountPaid = 10;
        expect(await service.previewForEntry(ENTRY)).toEqual({ amount: 10 });
        expect(invoice.impTotal).toBe(100); // La consulta no modifica datos.
        expect(
          (await service.issueForEntry(ENTRY, undefined, undefined, 10)).status,
        ).toBe('issued');
        expect(gateway.createCalls[0].ImpTotal).toBe(10);
        expect(Number(invoice.impTotal)).toBe(10);
      },
    );

    it('sin factura previa consulta el cobro y crea una sola factura al emitir', async () => {
      const { service, state, gateway } = setup();
      state.entries[0].amountPaid = 10.25;
      expect(await service.previewForEntry(ENTRY)).toEqual({ amount: 10.25 });
      expect(state.invoices).toHaveLength(0);
      await service.issueForEntry(ENTRY, undefined, undefined, 10.25);
      expect(gateway.createCalls[0].ImpTotal).toBe(10.25);
      expect(state.invoices).toHaveLength(1);
    });

    it('si cambia luego del aviso, rechaza sin llamar a ARCA; requiere reconfirmar', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state, { impTotal: 100 });
      const preview = await service.previewForEntry(ENTRY);
      state.entries[0].amountPaid = 10;
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(ENTRY, undefined, undefined, preview.amount),
          ),
        ),
      ).toBe('INVOICE_AMOUNT_CHANGED');
      expect(gateway.createCalls).toHaveLength(0);
      const refreshed = await service.previewForEntry(ENTRY);
      await service.issueForEntry(
        ENTRY,
        undefined,
        undefined,
        refreshed.amount,
      );
      expect(gateway.createCalls[0].ImpTotal).toBe(10);
    });

    it('desde Historial factura sólo los pagos elegidos y no permite otra factura', async () => {
      const { service, state, prisma, gateway } = setup();
      const qr = 'payment-qr';
      const mp = 'payment-mp';
      const cash = 'payment-cash';
      state.entries[0].amountPaid = 5000;
      state.entries[0].paymentTransactions = [
        {
          id: qr,
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: 'qr',
          amount: 2500,
          deletedAt: null,
        },
        {
          id: mp,
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: 'mp',
          amount: 1500,
          deletedAt: null,
        },
        {
          id: cash,
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: CASH,
          amount: 1000,
          deletedAt: null,
        },
      ];
      jest.spyOn(prisma.paymentMethod, 'findMany').mockResolvedValue([
        { id: 'qr', invoiceMode: 'auto' },
        { id: 'mp', invoiceMode: 'manual' },
        { id: CASH, invoiceMode: 'manual' },
      ]);

      expect(await service.previewForEntry(ENTRY, [qr])).toEqual({
        amount: 2500,
      });
      expect(await service.previewForEntry(ENTRY, [qr, mp])).toEqual({
        amount: 4000,
      });
      const result = await service.issueForEntry(
        ENTRY,
        undefined,
        undefined,
        2500,
        [qr],
      );
      expect(result.selectedPaymentIds).toEqual([qr]);
      expect(gateway.createCalls[0].ImpTotal).toBe(2500);
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(ENTRY, undefined, undefined, 1500, [mp]),
          ),
        ),
      ).toBe('INVOICE_ALREADY_ISSUED');
    });

    it('si una línea elegida cambia o se borra, no emite el importe viejo', async () => {
      const { service, state, gateway } = setup();
      const selected = ['payment-1'];
      expect(await service.previewForEntry(ENTRY, selected)).toEqual({
        amount: 1210,
      });
      state.entries[0].paymentTransactions[0].amount = 1000;
      expect(
        codeOf(
          await rejection(
            service.issueForEntry(ENTRY, undefined, undefined, 1210, selected),
          ),
        ),
      ).toBe('INVOICE_AMOUNT_CHANGED');
      state.entries[0].paymentTransactions[0].deletedAt = new Date();
      expect(
        codeOf(await rejection(service.previewForEntry(ENTRY, selected))),
      ).toBe('INVOICE_AMOUNT_CHANGED');
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('un rechazo de ARCA conserva los pagos seleccionados para reintentar', async () => {
      const { service, state, gateway } = setup();
      state.entries[0].amountPaid = 5000;
      state.entries[0].paymentTransactions[0].amount = 2500;
      gateway.willRespond('reject');
      const first = await service.issueForEntry(
        ENTRY,
        undefined,
        undefined,
        2500,
        ['payment-1'],
      );
      expect(first.status).toBe('error');
      expect(await service.previewForEntry(ENTRY)).toEqual({ amount: 2500 });
      await service.issueForEntry(ENTRY, undefined, undefined, 2500);
      expect(gateway.createCalls.at(-1)?.ImpTotal).toBe(2500);
    });

    it('actualiza el pendiente en la transaccion de correccion y no toca emitidas o inciertas', async () => {
      const { service, state, prisma } = setup();
      const pending = pendingInvoice(state, {
        impTotal: 100,
        selectedPaymentIds: ['payment-1'],
      });
      const issued = pendingInvoice(state, {
        entryId: 'issued',
        status: 'issued',
        impTotal: 100,
      });
      const uncertain = pendingInvoice(state, {
        entryId: 'uncertain',
        status: 'issuing',
        cbteNro: 1,
        impTotal: 100,
      });
      await service.updatePendingAmount(prisma as never, ENTRY, 10);
      await service.updatePendingAmount(prisma as never, 'issued', 10);
      await service.updatePendingAmount(prisma as never, 'uncertain', 10);
      expect(pending.impTotal).toBe(10);
      expect(pending.selectedPaymentIds).toEqual([]);
      expect(issued.impTotal).toBe(100);
      expect(uncertain.impTotal).toBe(100);
    });

    it('un reintento incierto conserva su importe original para reconciliar', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state, { impTotal: 100 });
      gateway.willRespond('timeout-but-approved');
      await service.issueForEntry(ENTRY);
      invoice.issuingStartedAt = new Date(Date.now() - STALE_ISSUING_MS - 1000);
      state.entries[0].amountPaid = 10;
      expect(await service.previewForEntry(ENTRY)).toEqual({ amount: 100 });
      await service.issueForEntry(ENTRY, undefined, undefined, 100);
      expect(gateway.createCalls).toHaveLength(1);
      expect(invoice.status).toBe('issued');
      expect(Number(invoice.impTotal)).toBe(100);
    });

    it.each([0, null])('no permite facturar un cobro %s', async (amount) => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      state.entries[0].amountPaid = amount;
      expect(codeOf(await rejection(service.previewForEntry(ENTRY)))).toBe(
        'INVOICE_NOT_INVOICEABLE',
      );
      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'INVOICE_NOT_INVOICEABLE',
      );
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('no consulta ni emite el ingreso de otro estacionamiento', async () => {
      const { service, state, gateway } = setup();
      state.entries[0].tenantId = 'other-tenant';
      expect(codeOf(await rejection(service.previewForEntry(ENTRY)))).toBe(
        'NOT_FOUND',
      );
      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'NOT_FOUND',
      );
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('el lote y clientes anteriores tambien usan el cobro corregido', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state, { impTotal: 100 });
      state.entries[0].amountPaid = 10;
      await service.issueBatch([ENTRY]);
      expect(gateway.createCalls[0].ImpTotal).toBe(10);
    });
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe('createForClosedEntry', () => {
    it('en un cobro dividido emite automáticamente sólo la línea elegida', async () => {
      const { service, state, prisma, gateway } = setup();
      const qr = '44444444-4444-7444-8444-444444444444';
      const cash = '55555555-5555-7555-8555-555555555555';
      const qrMethod = '66666666-6666-7666-8666-666666666666';
      state.entries[0].amountPaid = 5000;
      state.entries[0].paymentTransactions = [
        {
          id: qr,
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: qrMethod,
          amount: 2500,
          deletedAt: null,
        },
        {
          id: cash,
          tenantId: TENANT,
          entryId: ENTRY,
          paymentMethodId: CASH,
          amount: 2500,
          deletedAt: null,
        },
      ];
      jest.spyOn(prisma.paymentMethod, 'findMany').mockResolvedValue([
        { id: qrMethod, invoiceMode: 'auto' },
        { id: CASH, invoiceMode: 'manual' },
      ]);

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 5000,
        paymentMethodIds: [qrMethod, CASH],
        paymentLines: [
          { id: qr, amount: 2500, paymentMethodId: qrMethod },
          { id: cash, amount: 2500, paymentMethodId: CASH },
        ],
        selectedPaymentIds: [qr],
      });

      expect(created?.issueNow).toBe(true);
      expect(state.invoices[0].impTotal).toBe(2500);
      expect(state.invoices[0].selectedPaymentIds).toEqual([qr]);
      await service.issueAfterClose(created!.invoiceId);
      expect(gateway.createCalls[0].ImpTotal).toBe(2500);
    });

    it('rechaza una selección que no pertenece al cobro', async () => {
      const { service, prisma } = setup();
      expect(
        codeOf(
          await rejection(
            service.createForClosedEntry(prisma as never, {
              tenantId: TENANT,
              entryId: ENTRY,
              total: 1210,
              paymentMethodIds: [CASH],
              paymentLines: [
                { id: 'payment-1', amount: 1210, paymentMethodId: CASH },
              ],
              selectedPaymentIds: ['otro-pago'],
            }),
          ),
        ),
      ).toBe('INVOICE_AMOUNT_CHANGED');
    });

    it('medio en Automática → factura pendiente para emitir ya', async () => {
      const { service, state, prisma } = setup();

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
      });

      expect(created?.issueNow).toBe(true);
      expect(state.invoices[0].status).toBe('pending');
    });

    it('medio en Manual → factura no requerida, disponible para emisión posterior', async () => {
      const { service, state, prisma } = setup();
      jest
        .spyOn(prisma.paymentMethod, 'findMany')
        .mockResolvedValue([{ id: CASH, invoiceMode: 'manual' }]);

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
      });

      expect(created?.issueNow).toBe(false);
      expect(state.invoices[0].status).toBe('not_required');
      expect((await service.issueForEntry(ENTRY)).status).toBe('issued');
    });

    it('Manual con pendiente deja la factura pendiente sin emitirla al cobrar', async () => {
      const { service, state, prisma } = setup();
      jest
        .spyOn(prisma.paymentMethod, 'findMany')
        .mockResolvedValue([{ id: CASH, invoiceMode: 'manual_pending' }]);

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
      });

      expect(created?.issueNow).toBe(false);
      expect(state.invoices[0].status).toBe('pending');
      expect((await service.issueForEntry(ENTRY)).status).toBe('issued');
    });

    it('Desactivado no permite emitir desde el Historial', async () => {
      const { service, state, prisma } = setup();
      jest
        .spyOn(prisma.paymentMethod, 'findMany')
        .mockResolvedValue([{ id: CASH, invoiceMode: 'none' }]);

      await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
      });

      expect(state.invoices[0].status).toBe('not_required');
      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'INVOICE_MODE_DISABLED',
      );
      expect(codeOf(await rejection(service.previewForEntry(ENTRY)))).toBe(
        'INVOICE_MODE_DISABLED',
      );
    });

    it('sin cuenta ARCA vinculada no crea factura', async () => {
      const { service, state, prisma } = setup();
      state.account = null;

      expect(
        await service.createForClosedEntry(prisma as never, {
          tenantId: TENANT,
          entryId: ENTRY,
          total: 1210,
          paymentMethodIds: [CASH],
        }),
      ).toBeNull();
      expect(state.invoices).toHaveLength(0);
    });

    it('certificado vencido → queda pendiente con ARCA_CERT_EXPIRED', async () => {
      const { service, state, prisma } = setup();
      state.account!.certExpiresAt = new Date(Date.now() - 1000);

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
      });

      expect(created?.issueNow).toBe(false);
      expect(state.invoices[0].errorCode).toBe('ARCA_CERT_EXPIRED');
    });
  });

  describe('Factura A', () => {
    const RECEIVER = '30712345671';

    it('RI con CUIT del cliente → A con DocTipo 80 y la razón social', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      const summary = await service.issueForEntry(
        ENTRY,
        undefined,
        '30-71234567-1',
      );

      expect(summary.status).toBe('issued');
      expect(summary.cbteTipo).toBe(1);
      expect(summary.receptorNombre).toBe('EMPRESA CLIENTE SA');
      expect(gateway.createCalls[0]).toMatchObject({
        CbteTipo: 1,
        DocTipo: 80,
        DocNro: Number(RECEIVER),
        CondicionIVAReceptorId: 1,
      });
    });

    it('receptor monotributista → A con condición 6', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      gateway.taxpayer = {
        datosGenerales: { apellido: 'PEREZ', nombre: 'JUAN' },
        datosMonotributo: { categoriaMonotributo: {} },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.cbteTipo).toBe(1);
      expect(gateway.createCalls[0].CondicionIVAReceptorId).toBe(6);
    });

    it('receptor exento → B identificada con el CUIT y condición 4', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'FUNDACION' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 32 } },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.status).toBe('issued');
      expect(summary.cbteTipo).toBe(6);
      expect(summary.receptorNombre).toBe('FUNDACION');
      expect(gateway.createCalls[0]).toMatchObject({
        CbteTipo: 6,
        DocTipo: 80,
        DocNro: Number(RECEIVER),
        CondicionIVAReceptorId: 4,
      });
    });

    it('emisor monotributista con CUIT → C identificada, sin IVA', async () => {
      const { service, state, gateway } = setup('monotributo');
      pendingInvoice(state);
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.cbteTipo).toBe(11);
      expect(gateway.createCalls[0]).toMatchObject({
        CbteTipo: 11,
        DocTipo: 80,
        DocNro: Number(RECEIVER),
        CondicionIVAReceptorId: 1,
        ImpIVA: 0,
      });
      expect(gateway.createCalls[0].Iva).toBeUndefined();
    });

    it('producción sin datos en el padrón → error INVOICE_RECEIVER_NOT_FOUND y no se manda nada', async () => {
      const { service, state, gateway } = setup(
        'responsable_inscripto',
        'produccion',
      );
      pendingInvoice(state);

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.status).toBe('error');
      expect(summary.errorCode).toBe('INVOICE_RECEIVER_NOT_FOUND');
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('padrón caído → error ARCA_UNAVAILABLE sin numerar', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      gateway.taxpayerError = new ArcaUnavailableError('timeout');

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.errorCode).toBe('ARCA_UNAVAILABLE');
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('usa la caché del padrón y marca el CUIT como usado al emitir', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      state.receivers.push({
        tenantId: TENANT,
        cuit: RECEIVER,
        razonSocial: 'EN CACHE SA',
        condicionIvaReceptorId: 1,
        fetchedAt: new Date(),
        lastUsedAt: null,
      });

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.receptorNombre).toBe('EN CACHE SA');
      expect(gateway.taxpayerCalls).toHaveLength(0);
      expect(state.receivers[0].lastUsedAt).toBeInstanceOf(Date);
    });

    it('caché vencida → vuelve a consultar el padrón', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      state.receivers.push({
        tenantId: TENANT,
        cuit: RECEIVER,
        razonSocial: 'VIEJA SA',
        condicionIvaReceptorId: 1,
        fetchedAt: new Date(Date.now() - PADRON_CACHE_TTL_MS - 1000),
        lastUsedAt: null,
      });
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'NUEVA SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 32 } },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(gateway.taxpayerCalls).toEqual([RECEIVER]);
      expect(summary.receptorNombre).toBe('NUEVA SA');
      expect(state.receivers[0]).toMatchObject({
        razonSocial: 'NUEVA SA',
        condicionIvaReceptorId: 4,
      });
    });

    it('con CUIT no aplica el tope de consumidor final', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state, { impTotal: 12_000_000 });
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.status).toBe('issued');
      expect(summary.cbteTipo).toBe(1);
    });

    it('reintentar sin CUIT después de una A fallida → B a consumidor final', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state, { receptorDocTipo: 80, receptorDocNro: RECEIVER });

      const summary = await service.issueForEntry(ENTRY);

      expect(summary.cbteTipo).toBe(6);
      expect(gateway.createCalls[0].DocTipo).toBe(99);
    });

    it('CUIT con dígito verificador inválido → 422 ARCA_CUIT_INVALID', async () => {
      const { service, state } = setup();
      pendingInvoice(state);

      expect(
        codeOf(
          await rejection(
            service.issueForEntry(ENTRY, undefined, '30712345670'),
          ),
        ),
      ).toBe('ARCA_CUIT_INVALID');
    });

    it('al cobrar con CUIT inválido la factura queda pendiente, el cierre no falla', async () => {
      const { service, state, prisma } = setup();

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
        receiverCuit: '30712345670',
      });

      expect(created?.issueNow).toBe(false);
      expect(state.invoices[0].errorCode).toBe('ARCA_CUIT_INVALID');
    });

    it('emisor monotributista: al cobrar con CUIT también lo guarda', async () => {
      const { service, state, prisma } = setup('monotributo');

      await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
        receiverCuit: RECEIVER,
      });

      expect(state.invoices[0]).toMatchObject({
        receptorDocTipo: 80,
        receptorDocNro: RECEIVER,
      });
    });

    it('al cobrar con CUIT válido guarda el receptor para la emisión', async () => {
      const { service, state, prisma } = setup();

      const created = await service.createForClosedEntry(prisma as never, {
        tenantId: TENANT,
        entryId: ENTRY,
        total: 1210,
        paymentMethodIds: [CASH],
        receiverCuit: '30-71234567-1',
      });

      expect(created?.issueNow).toBe(true);
      expect(state.invoices[0]).toMatchObject({
        receptorDocTipo: 80,
        receptorDocNro: RECEIVER,
      });
    });
  });

  describe('lookupTaxpayer', () => {
    const RECEIVER = '30712345671';

    it('RI + receptor RI → A con razón social y condición', async () => {
      const { service, gateway } = setup();
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      expect(await service.lookupTaxpayer('30-71234567-1')).toEqual({
        cuit: RECEIVER,
        identified: true,
        letter: 'A',
        razonSocial: 'EMPRESA CLIENTE SA',
        condicionIvaReceptorId: 1,
        condicionIva: 'IVA Responsable Inscripto',
        assumed: false,
      });
    });

    it('RI + exento → B identificada', async () => {
      const { service, gateway } = setup();
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'FUNDACION' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 32 } },
      };

      expect(await service.lookupTaxpayer(RECEIVER)).toMatchObject({
        identified: true,
        letter: 'B',
        condicionIvaReceptorId: 4,
      });
    });

    it('emisor monotributista → siempre C', async () => {
      const { service, gateway } = setup('monotributo');
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      expect(await service.lookupTaxpayer(RECEIVER)).toMatchObject({
        identified: true,
        letter: 'C',
      });
    });

    it('producción sin datos → no identificado, sale a consumidor final', async () => {
      const { service } = setup('responsable_inscripto', 'produccion');

      expect(await service.lookupTaxpayer(RECEIVER)).toMatchObject({
        identified: false,
        letter: 'B',
        razonSocial: null,
        condicionIvaReceptorId: null,
        assumed: false,
      });
    });

    it('homologación sin datos → se asume RI (A) y lo avisa', async () => {
      const { service } = setup();

      expect(await service.lookupTaxpayer(RECEIVER)).toMatchObject({
        identified: true,
        letter: 'A',
        assumed: true,
      });
    });

    it('la segunda consulta sale de la caché', async () => {
      const { service, gateway } = setup();
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'EMPRESA CLIENTE SA' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
      };

      await service.lookupTaxpayer(RECEIVER);
      await service.lookupTaxpayer(RECEIVER);

      expect(gateway.taxpayerCalls).toHaveLength(1);
    });

    it('CUIT inválido → 422 ARCA_CUIT_INVALID', async () => {
      const { service } = setup();
      expect(
        codeOf(await rejection(service.lookupTaxpayer('30712345670'))),
      ).toBe('ARCA_CUIT_INVALID');
    });

    it('sin ARCA vinculada → 409 ARCA_NOT_LINKED', async () => {
      const { service, state } = setup();
      state.account = null;
      expect(codeOf(await rejection(service.lookupTaxpayer(RECEIVER)))).toBe(
        'ARCA_NOT_LINKED',
      );
    });

    it('ARCA caída → 503 ARCA_UNAVAILABLE', async () => {
      const { service, gateway } = setup();
      gateway.taxpayerError = new ArcaUnavailableError('timeout');
      const error = await rejection(service.lookupTaxpayer(RECEIVER));
      expect(codeOf(error)).toBe('ARCA_UNAVAILABLE');
      expect((error as FormattedException).getStatus()).toBe(503);
    });
  });

  describe('receiverSuggestions', () => {
    it('sólo los usados, del más reciente al más viejo, filtrando por CUIT', async () => {
      const { service, state } = setup();
      const at = (m: number) => new Date(Date.UTC(2026, 8, 1, 0, m));
      state.receivers.push(
        { tenantId: TENANT, cuit: '30712345671', lastUsedAt: at(1) },
        { tenantId: TENANT, cuit: '20111111112', lastUsedAt: at(3) },
        { tenantId: TENANT, cuit: '30999999999', lastUsedAt: null },
        { tenantId: 'otra', cuit: '30888888888', lastUsedAt: at(5) },
        { tenantId: TENANT, cuit: '30222222222', lastUsedAt: at(2) },
      );

      const all = await service.receiverSuggestions(undefined, 10);
      expect(all.map((r) => r.cuit)).toEqual([
        '20111111112',
        '30222222222',
        '30712345671',
      ]);

      const filtered = await service.receiverSuggestions('30-7', 10);
      expect(filtered.map((r) => r.cuit)).toEqual(['30712345671']);
    });
  });

  describe('emisión', () => {
    it('RI → B aprobada con CAE, número 1 y foto del emisor', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);

      const summary = await service.issueAfterClose(invoice.id);

      expect(summary?.status).toBe('issued');
      expect(summary?.cbteTipo).toBe(6);
      expect(summary?.cbteNro).toBe(1);
      expect(summary?.cae).toMatch(/^\d{14}$/);
      expect(state.invoices[0].emisorRazonSocial).toBe(
        'DE LA CRUZ JUAN MARTIN',
      );
      expect(gateway.createCalls[0]).toMatchObject({
        Concepto: 2,
        DocTipo: 99,
        CondicionIVAReceptorId: 5,
        FchServDesde: '20260924',
        FchServHasta: '20260924',
      });
    });

    it('Monotributo → C, sin IVA discriminado', async () => {
      const { service, state, gateway } = setup('monotributo');
      const invoice = pendingInvoice(state);

      const summary = await service.issueAfterClose(invoice.id);

      expect(summary?.cbteTipo).toBe(11);
      expect(gateway.createCalls[0].ImpIVA).toBe(0);
      expect(gateway.createCalls[0].Iva).toBeUndefined();
    });

    it('dos emisiones simultáneas de la misma estadía → un solo comprobante', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);

      const [a, b] = await Promise.allSettled([
        service.issueForEntry(ENTRY),
        service.issueForEntry(ENTRY),
      ]);

      expect(gateway.createCalls).toHaveLength(1);
      expect(state.invoices[0].status).toBe('issued');
      const rejected = [a, b].find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        FormattedException,
      );
      expect(invoice.cbteNro).toBe(1);
    });

    it('sin ARCA vinculada, emitir a pedido → ARCA_NOT_LINKED y no crea la factura', async () => {
      const { service, state } = setup();
      state.account = null;

      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'ARCA_NOT_LINKED',
      );
      expect(state.invoices).toHaveLength(0);
    });

    it('re-emitir una factura emitida → INVOICE_ALREADY_ISSUED', async () => {
      const { service, state } = setup();
      pendingInvoice(state);
      await service.issueForEntry(ENTRY);

      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'INVOICE_ALREADY_ISSUED',
      );
    });

    it('rechazo de ARCA → error con el motivo y el número liberado', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);
      gateway.willRespond('reject');

      const summary = await service.issueAfterClose(invoice.id);

      expect(summary?.status).toBe('error');
      expect(summary?.errorCode).toBe('INVOICE_REJECTED');
      expect(summary?.errorMessage).toContain('10016');
      expect(state.invoices[0].cbteNro).toBeNull();
    });

    it('timeout sin respuesta → queda issuing con su número; al reintentar se reconcilia y re-emite sin duplicar', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);
      gateway.willRespond('timeout');

      const first = await service.issueAfterClose(invoice.id);
      expect(first?.status).toBe('issuing');
      expect(state.invoices[0].cbteNro).toBe(1);

      // Pasan los 2 minutos: el reintento consulta a ARCA, que no lo tiene.
      state.invoices[0].issuingStartedAt = new Date(
        Date.now() - STALE_ISSUING_MS - 1000,
      );
      const retry = await service.issueForEntry(ENTRY);

      expect(retry.status).toBe('issued');
      expect(retry.cbteNro).toBe(1);
      expect(gateway.vouchers.size).toBe(1);
    });

    it('timeout pero ARCA sí lo autorizó → el reintento lo reconcilia sin emitir otro', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);
      gateway.willRespond('timeout-but-approved');

      await service.issueAfterClose(invoice.id);
      state.invoices[0].issuingStartedAt = new Date(
        Date.now() - STALE_ISSUING_MS - 1000,
      );
      const retry = await service.issueForEntry(ENTRY);

      expect(retry.status).toBe('issued');
      expect(retry.cae).toMatch(/^\d{14}$/);
      expect(gateway.createCalls).toHaveLength(1);
    });

    it('una emisión en curso reciente bloquea el reintento → INVOICE_IN_PROGRESS', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);
      gateway.willRespond('timeout');
      await service.issueAfterClose(invoice.id);

      expect(codeOf(await rejection(service.issueForEntry(ENTRY)))).toBe(
        'INVOICE_IN_PROGRESS',
      );
    });

    it('ARCA caída antes de numerar → error ARCA_UNAVAILABLE, sin tirar', async () => {
      const { service, state, gateway } = setup();
      const invoice = pendingInvoice(state);
      jest
        .spyOn(gateway, 'getLastVoucher')
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      const summary = await service.issueAfterClose(invoice.id);

      expect(summary?.status).toBe('error');
      expect(summary?.errorCode).toBe('ARCA_UNAVAILABLE');
      expect(state.invoices[0].cbteNro).toBeNull();
      expect(gateway.createCalls).toHaveLength(0);
    });

    it('audita cada llamada a ARCA en arca_requests', async () => {
      const { service, state, prisma } = setup();
      const invoice = pendingInvoice(state);

      await service.issueAfterClose(invoice.id);

      const operations = (
        prisma.arcaRequest.create.mock.calls as Array<
          [{ data: { operation: string } }]
        >
      ).map(([arg]) => arg.data.operation);
      expect(operations).toEqual(['getLastVoucher', 'createVoucher']);
    });
  });

  describe('issueBatch', () => {
    const OTHER = '44444444-4444-7444-8444-444444444444';
    const THIRD = '55555555-5555-7555-8555-555555555555';

    it('devuelve el resultado de cada estadía; un conflicto no corta el lote', async () => {
      const { service, state } = setup();
      pendingInvoice(state);
      pendingInvoice(state, { entryId: OTHER, status: 'issued' });
      pendingInvoice(state, { entryId: THIRD });
      state.entries.push({
        ...state.entries[0],
        id: THIRD,
        paymentTransactions: [
          {
            ...(state.entries[0].paymentTransactions as Row[])[0],
            id: 'third-payment',
            entryId: THIRD,
          },
        ],
      });

      const { results } = await service.issueBatch([ENTRY, OTHER, THIRD]);

      expect(results.map((r) => [r.entryId, r.errorCode])).toEqual([
        [ENTRY, null],
        [OTHER, 'INVOICE_ALREADY_ISSUED'],
        [THIRD, null],
      ]);
      expect(results[0].invoice?.cbteNro).toBe(1);
      expect(results[2].invoice?.cbteNro).toBe(2);
    });

    it('si ARCA no responde, las que faltan no se intentan', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      pendingInvoice(state, { entryId: OTHER });
      const lastVoucher = jest
        .spyOn(gateway, 'getLastVoucher')
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      const { results } = await service.issueBatch([ENTRY, OTHER]);

      expect(results.map((r) => r.errorCode)).toEqual([
        'ARCA_UNAVAILABLE',
        'ARCA_UNAVAILABLE',
      ]);
      expect(results[1].invoice).toBeNull();
      expect(lastVoucher).toHaveBeenCalledTimes(1);
      expect(state.invoices[1].status).toBe('pending');
    });
  });

  describe('reconcileStaleIssuing (job diario)', () => {
    const OLD = () => new Date(Date.now() - 11 * 60_000);
    const numbered = {
      status: 'issuing',
      environment: 'homologacion',
      emisorCuit: '20447275865',
      ptoVta: 1,
      cbteTipo: 6,
    };

    it('ARCA la tiene → issued con su CAE; no la tiene → error y libera el número', async () => {
      const { service, state, gateway } = setup();
      gateway.vouchers.set('1:6:7', { cae: '123', caeVto: '20261004' });
      const found = pendingInvoice(state, {
        ...numbered,
        cbteNro: 7,
        issuingStartedAt: OLD(),
      });
      const missing = pendingInvoice(state, {
        ...numbered,
        cbteNro: 8,
        issuingStartedAt: OLD(),
      });

      const result = await service.reconcileStaleIssuing({
        olderThanMs: 10 * 60_000,
        limit: 50,
      });

      expect(result).toEqual({ reconciled: 2, failed: 0 });
      expect(found).toMatchObject({ status: 'issued', cae: '123' });
      expect(missing).toMatchObject({ status: 'error', cbteNro: null });
    });

    it('no toca una emisión reciente', async () => {
      const { service, state } = setup();
      const recent = pendingInvoice(state, {
        ...numbered,
        cbteNro: 7,
        issuingStartedAt: new Date(),
      });

      await service.reconcileStaleIssuing({
        olderThanMs: 10 * 60_000,
        limit: 50,
      });

      expect(recent.status).toBe('issuing');
    });
  });
});
