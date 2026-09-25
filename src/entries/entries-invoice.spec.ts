import type { InvoicesService } from '../arca/invoices.service';
import type { PrismaService } from '../database/prisma.service';
import type { TenantContextService } from '../database/tenant-context.service';
import { EntriesService } from './entries.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY = '22222222-2222-7222-8222-222222222222';
const CASH = '33333333-3333-7333-8333-333333333333';

function setup(invoices: unknown) {
  const current = {
    id: ENTRY,
    tenantId: TENANT,
    plate: 'AB123CD',
    enteredAt: new Date('2026-09-24T13:00:00.000Z'),
    leftAt: null,
    rateSnapshotHourPriceArs: null,
    rateSnapshotStayPriceArs: null,
    rateSnapshotFractionPriceArs: null,
    rateSnapshotMediaEstadiaPriceArs: null,
  };
  const tx = {
    entry: {
      findFirst: jest.fn().mockResolvedValue(current),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...current,
        leftAt: new Date('2026-09-24T15:30:00.000Z'),
        amountPaid: 1210,
      }),
    },
    cashSession: { findFirst: jest.fn().mockResolvedValue(null) },
    paymentMethod: {
      findMany: jest.fn().mockResolvedValue([{ id: CASH, type: 'cash' }]),
    },
    paymentTransaction: { createMany: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const service = new EntriesService(
    prisma as unknown as PrismaService,
    { getTenantIdOrThrow: () => TENANT } as unknown as TenantContextService,
    invoices as InvoicesService,
  );
  return { service, tx };
}

const close = (service: EntriesService) =>
  service.closeEntry(ENTRY, 1, {
    leftAt: '2026-09-24T15:30:00.000Z',
    payments: [
      {
        id: '44444444-4444-7444-8444-444444444444',
        paymentMethodId: CASH,
        paymentMethodName: 'Efectivo',
        amount: 1210,
      },
    ],
  });

describe('EntriesService.closeEntry — factura', () => {
  it('crea la factura en la transacción del cierre y la emite después', async () => {
    const summary = { id: 'inv-1', status: 'issued', cbteTipo: 6 };
    const invoices = {
      createForClosedEntry: jest
        .fn()
        .mockResolvedValue({ invoiceId: 'inv-1', issueNow: true }),
      issueAfterClose: jest.fn().mockResolvedValue(summary),
    };
    const { service, tx } = setup(invoices);

    const result = await close(service);

    expect(invoices.createForClosedEntry).toHaveBeenCalledWith(tx, {
      tenantId: TENANT,
      entryId: ENTRY,
      total: 1210,
      paymentMethodIds: [CASH],
    });
    expect(result.invoice?.status).toBe('issued');
    expect(result.id).toBe(ENTRY);
  });

  it('si ARCA falla, el cierre igual se completa y trae la factura en error', async () => {
    const failed = {
      id: 'inv-1',
      status: 'error',
      errorCode: 'ARCA_UNAVAILABLE',
    };
    const invoices = {
      createForClosedEntry: jest
        .fn()
        .mockResolvedValue({ invoiceId: 'inv-1', issueNow: true }),
      issueAfterClose: jest.fn().mockResolvedValue(failed),
    };
    const { service } = setup(invoices);

    const result = await close(service);

    expect(result.leftAt).toBeInstanceOf(Date);
    expect(result.invoice?.errorCode).toBe('ARCA_UNAVAILABLE');
  });

  it('sin ARCA vinculada, invoice = null', async () => {
    const invoices = {
      createForClosedEntry: jest.fn().mockResolvedValue(null),
      issueAfterClose: jest.fn(),
    };
    const { service } = setup(invoices);

    const result = await close(service);

    expect(result.invoice).toBeNull();
    expect(invoices.issueAfterClose).not.toHaveBeenCalled();
  });
});
