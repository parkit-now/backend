/* eslint-disable @typescript-eslint/no-unsafe-argument -- el Prisma en memoria
   guarda filas sin tipar y los tests leen campos sueltos. */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import type { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { FakeArcaGateway } from './fake-arca.gateway';
import { InvoicesService, STALE_ISSUING_MS } from './invoices.service';

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
function memoryPrisma(state: { invoices: Row[]; account: Row | null }) {
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
      const row: Row = { id: `inv-${state.invoices.length + 1}` };
      applyData(row, data);
      state.invoices.push(row);
      return Promise.resolve(row);
    },
  };
  const prisma = {
    invoice,
    arcaAccount: { findUnique: () => Promise.resolve(state.account) },
    arcaRequest: { create: jest.fn().mockResolvedValue(undefined) },
    paymentMethod: {
      findMany: () => Promise.resolve([{ id: CASH, invoiceMode: 'auto' }]),
    },
    entry: {
      findUniqueOrThrow: () =>
        Promise.resolve({
          enteredAt: new Date('2026-09-24T13:00:00.000Z'),
          leftAt: new Date('2026-09-24T15:30:00.000Z'),
        }),
    },
    $executeRaw: () => Promise.resolve(1),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return prisma;
}

function setup(condicionIva = 'responsable_inscripto') {
  const env: Record<string, string> = {
    ARCA_ENV: 'homologacion',
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
    account: {
      tenantId: TENANT,
      environment: 'homologacion',
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
    gateway,
  );
  return { service, state, gateway, prisma };
}

function pendingInvoice(state: { invoices: Row[] }, extra: Row = {}): Row {
  const row = {
    id: `inv-${state.invoices.length + 1}`,
    tenantId: TENANT,
    entryId: ENTRY,
    status: 'pending',
    impTotal: 1210,
    attempts: 0,
    cbteNro: null,
    issuingStartedAt: null,
    errorCode: null,
    errorMessage: null,
    ...extra,
  };
  state.invoices.push(row);
  return row;
}

describe('InvoicesService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe('createForClosedEntry', () => {
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

    it('receptor exento → error INVOICE_RECEIVER_NOT_A y no se manda nada', async () => {
      const { service, state, gateway } = setup();
      pendingInvoice(state);
      gateway.taxpayer = {
        datosGenerales: { razonSocial: 'FUNDACION' },
        datosRegimenGeneral: { impuesto: { idImpuesto: 32 } },
      };

      const summary = await service.issueForEntry(ENTRY, undefined, RECEIVER);

      expect(summary.status).toBe('error');
      expect(summary.errorCode).toBe('INVOICE_RECEIVER_NOT_A');
      expect(gateway.createCalls).toHaveLength(0);
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
