import { EntriesService } from './entries.service';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { AuditActions } from '../audit/audit.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENTRY = '22222222-2222-7222-8222-222222222222';
const SESSION = '33333333-3333-7333-8333-333333333333';
const USER = { id: '44444444-4444-7444-8444-444444444444' };
const OWNER = { role: 'owner' };

function setup(overrides: Record<string, unknown> = {}) {
  const entry = {
    id: ENTRY,
    tenantId: TENANT,
    plate: 'ABC123',
    ticketNumber: 7,
    amountPaid: 100,
    version: 2,
    deletedAt: null,
    cashSessionId: SESSION,
    cashSession: { id: SESSION, closedAt: null },
    reservationId: null,
    manuallyInvoiced: false,
    invoice: null,
    paymentTransactions: [],
    ...overrides,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    entry: {
      findFirst: jest.fn().mockResolvedValue(entry),
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ ...entry, deletedAt: new Date() }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentIntent: { findFirst: jest.fn().mockResolvedValue(null) },
    cashSession: { count: jest.fn().mockResolvedValue(1) },
    paymentTransaction: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
  };
  const prisma = {
    $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const context = { getTenantIdOrThrow: () => TENANT };
  const service = new EntriesService(
    prisma as unknown as PrismaService,
    context as unknown as TenantContextService,
  );
  const remove = (membership = OWNER, version = 2) =>
    service.deleteEntry(
      ENTRY,
      { expectedVersion: version, reason: 'Error de carga' },
      USER as never,
      membership as never,
    );
  return { tx, service, remove };
}

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
}

describe('EntriesService.deleteEntry', () => {
  it('sólo admite al dueño', async () => {
    const { tx, remove } = setup();
    await expectRejected(remove({ role: 'operator' }));
    await expectRejected(remove({ role: 'admin' }));
    expect(tx.entry.updateMany).not.toHaveBeenCalled();
  });

  it('borra ingreso y pagos de forma lógica, con auditoría y versión', async () => {
    const payment = {
      id: '55555555-5555-7555-8555-555555555555',
      entryId: ENTRY,
      cashSessionId: SESSION,
      paymentMethodType: 'cash',
      amount: 100,
      deletedAt: null,
    };
    const { tx, remove } = setup({ paymentTransactions: [payment] });
    tx.paymentTransaction.findMany.mockResolvedValue([
      { ...payment, deletedAt: new Date() },
    ]);
    const result = await remove();
    expect(result.entry.deletedAt).not.toBeNull();
    expect(result.deletedPaymentTransactions).toHaveLength(1);
    const entryUpdate = tx.entry.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { deletedAt: Date; version: { increment: number } };
    };
    expect(entryUpdate.where).toEqual({
      id: ENTRY,
      tenantId: TENANT,
      deletedAt: null,
      version: 2,
    });
    expect(entryUpdate.data.deletedAt).toBeInstanceOf(Date);
    expect(entryUpdate.data.version.increment).toBe(1);
    const paymentUpdate = tx.paymentTransaction.updateMany.mock
      .calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { deletedAt: Date };
    };
    expect(paymentUpdate.where).toEqual({
      tenantId: TENANT,
      entryId: ENTRY,
      deletedAt: null,
    });
    expect(paymentUpdate.data.deletedAt).toBeInstanceOf(Date);
    const audit = tx.auditLog.create.mock.calls[0]?.[0] as {
      data: {
        action: string;
        actorUserId: string;
        tenantId: string;
        metadata: {
          actorRole: string;
          origin: string;
          reason: string;
          amountPaid: number;
        };
      };
    };
    expect(audit.data.action).toBe(AuditActions.ENTRY_DELETED);
    expect(audit.data.actorUserId).toBe(USER.id);
    expect(audit.data.tenantId).toBe(TENANT);
    expect(audit.data.metadata.actorRole).toBe('owner');
    expect(audit.data.metadata.origin).toBe('desktop');
    expect(audit.data.metadata.reason).toBe('Error de carga');
    expect(audit.data.metadata.amountPaid).toBe(100);
  });

  it('bloquea versión obsoleta, caja cerrada y cobro en caja cerrada', async () => {
    await expectRejected(setup().remove(OWNER, 1));
    await expectRejected(
      setup({ cashSession: { id: SESSION, closedAt: new Date() } }).remove(),
    );
    const { tx, remove } = setup({
      paymentTransactions: [
        {
          deletedAt: null,
          paymentMethodType: 'cash',
          cashSessionId: '66666666-6666-7666-8666-666666666666',
        },
      ],
    });
    tx.cashSession.count.mockResolvedValue(1);
    await expectRejected(remove());
    expect(tx.entry.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea reservas, facturas y cobros QR', async () => {
    await expectRejected(setup({ reservationId: 'reservation-1' }).remove());
    await expectRejected(setup({ manuallyInvoiced: true }).remove());
    await expectRejected(setup({ invoice: { status: 'issued' } }).remove());
    await expectRejected(setup({ invoice: { status: 'issuing' } }).remove());
    await expectRejected(
      setup({ invoice: { status: 'error', cbteNro: 8 } }).remove(),
    );
    await expectRejected(
      setup({
        paymentTransactions: [
          { deletedAt: null, paymentMethodType: 'mercadopago_qr' },
        ],
      }).remove(),
    );
    const { tx, remove } = setup();
    tx.paymentIntent.findFirst.mockResolvedValue({ id: 'intent-1' });
    await expectRejected(remove());
  });

  it('permite facturas pendientes o con error sin número de comprobante', async () => {
    for (const status of ['pending', 'error', 'not_required']) {
      const result = await setup({
        invoice: { status, cbteNro: null },
      }).remove();
      expect(result.entry).toBeDefined();
    }
  });
});
