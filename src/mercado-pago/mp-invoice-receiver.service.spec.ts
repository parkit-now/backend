import { Test } from '@nestjs/testing';
import { Prisma, type PaymentIntent } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { MpApiClient, type MpPayment } from './mp-api.client';
import { MpInvoiceReceiverService } from './mp-invoice-receiver.service';
import { MpTokenService } from './mp-token.service';

const CUIT = '20427205208';
const OTHER_CUIT = '30712345671';
const TENANT = 'tenant';
const ENTRY = 'entry';
type IntentQuery = {
  where: {
    id?: string;
    tenantId: string;
    entryId: string;
    status: string;
    paymentTransactionId?: { in: string[] };
  };
};

describe('MpInvoiceReceiverService', () => {
  const context = new TenantContextService();
  const entry = { findFirst: jest.fn() };
  const transactions = { findMany: jest.fn() };
  const intents = { findMany: jest.fn(), updateMany: jest.fn() };
  const prisma = {
    getTenantClient: () => ({ entry, paymentTransaction: transactions }),
    paymentIntent: intents,
  };
  const mp = { getOrder: jest.fn(), getPayment: jest.fn() };
  const tokens = { getUsableAccessToken: jest.fn() };
  let service: MpInvoiceReceiverService;
  let rows: PaymentIntent[];
  const makeIntent = (
    overrides: Partial<PaymentIntent> = {},
  ): PaymentIntent => ({
    id: 'intent',
    tenantId: TENANT,
    entryId: ENTRY,
    status: 'approved',
    amount: new Prisma.Decimal('100.10'),
    mpOrderId: 'order',
    mpPaymentReferenceId: null,
    payerCuit: null,
    mpStatus: 'processed',
    mpStatusDetail: null,
    expiresAt: new Date(),
    approvedAt: new Date(),
    consumedAt: null,
    paymentTransactionId: null,
    failureReason: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const payment = (overrides: Partial<MpPayment> = {}): MpPayment => ({
    id: '123',
    status: 'approved',
    statusDetail: 'accredited',
    externalReference: 'intent',
    transactionAmount: 100.1,
    transactionAmountRefunded: 0,
    collectorId: 'seller',
    payerIdentification: { type: 'CUIT', number: CUIT },
    ...overrides,
  });
  const suggest = (id?: string) =>
    context.runWithTenant(TENANT, () => service.suggest(ENTRY, id));

  beforeEach(async () => {
    jest.resetAllMocks();
    rows = [makeIntent()];
    entry.findFirst.mockResolvedValue({ id: ENTRY });
    transactions.findMany.mockResolvedValue([{ id: 'transaction' }]);
    intents.findMany.mockImplementation(({ where }: IntentQuery) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.entryId === where.entryId &&
            row.status === where.status &&
            (!where.id || row.id === where.id) &&
            (!where.paymentTransactionId ||
              where.paymentTransactionId.in.includes(
                row.paymentTransactionId ?? '',
              )),
        ),
      ),
    );
    intents.updateMany.mockResolvedValue({ count: 1 });
    tokens.getUsableAccessToken.mockResolvedValue({
      accessToken: 'token',
      account: { mpUserId: 'seller' },
    });
    mp.getOrder.mockResolvedValue({
      id: 'order',
      status: 'processed',
      externalReference: 'intent',
      payments: [{ referenceId: '123', status: 'processed' }],
    });
    mp.getPayment.mockResolvedValue(payment());
    const module = await Test.createTestingModule({
      providers: [
        MpInvoiceReceiverService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: context },
        { provide: MpApiClient, useValue: mp },
        { provide: MpTokenService, useValue: tokens },
      ],
    }).compile();
    service = module.get(MpInvoiceReceiverService);
  });

  it('verifica el pago por reference_id y persiste solamente referencia y CUIT', async () => {
    expect(await suggest('intent')).toEqual({ cuit: CUIT });
    expect(mp.getPayment).toHaveBeenCalledWith('token', '123');
    expect(tokens.getUsableAccessToken).toHaveBeenCalledWith(TENANT);
    expect(intents.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'intent',
        tenantId: TENANT,
        entryId: ENTRY,
        status: 'approved',
        mpOrderId: 'order',
        amount: new Prisma.Decimal('100.10'),
      },
      data: { mpPaymentReferenceId: '123', payerCuit: CUIT },
    });
  });

  it.each([
    { payerIdentification: null },
    { payerIdentification: { type: 'DNI', number: CUIT } },
    { payerIdentification: { type: 'CUIL', number: CUIT } },
    { payerIdentification: { type: 'CUIT', number: '20427205209' } },
    { payerIdentification: { type: 'CUIT', number: '00000000000' } },
    { payerIdentification: { type: 'CUIT', number: '20-42720520-8' } },
    { status: 'pending' },
    { collectorId: 'other-seller' },
    { externalReference: 'other-intent' },
    { id: 'PAY123' },
    { transactionAmount: 100.11 },
    { transactionAmount: null },
    { transactionAmountRefunded: 1 },
  ])(
    'ignora identificaciones o pagos no verificables: %j',
    async (overrides) => {
      mp.getPayment.mockResolvedValue(payment(overrides));
      expect(await suggest('intent')).toEqual({ cuit: null });
      expect(intents.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['PAY123', null])(
    'no usa el identificador PAY como referencia: %s',
    async (referenceId) => {
      mp.getOrder.mockResolvedValue({
        id: 'order',
        status: 'processed',
        externalReference: 'intent',
        payments: [{ referenceId, status: 'processed' }],
      });
      expect(await suggest('intent')).toEqual({ cuit: null });
      expect(mp.getPayment).not.toHaveBeenCalled();
    },
  );

  it('ignora una orden cruzada', async () => {
    mp.getOrder.mockResolvedValue({
      id: 'order',
      status: 'processed',
      externalReference: 'another',
      payments: [{ referenceId: '123', status: 'processed' }],
    });
    expect(await suggest('intent')).toEqual({ cuit: null });
    expect(mp.getPayment).not.toHaveBeenCalled();
  });

  it('reutiliza el CUIT verificado aunque la cuenta se haya desvinculado', async () => {
    rows = [makeIntent({ payerCuit: CUIT, mpPaymentReferenceId: '123' })];
    expect(await suggest('intent')).toEqual({ cuit: CUIT });
    expect(tokens.getUsableAccessToken).not.toHaveBeenCalled();
    expect(mp.getOrder).not.toHaveBeenCalled();
  });

  it.each([
    { tenantId: 'another' },
    { entryId: 'another' },
    { status: 'pending' as const },
    { status: 'consumed' as const },
  ])('no acepta intentos ajenos o no aprobados: %j', async (overrides) => {
    rows = [makeIntent(overrides)];
    expect(
      await suggest('intent').catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
    expect(mp.getOrder).not.toHaveBeenCalled();
  });

  it('sin ingreso no consulta datos del pago', async () => {
    entry.findFirst.mockResolvedValue(null);
    expect(
      await suggest('intent').catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
    expect(intents.findMany).not.toHaveBeenCalled();
  });

  it('historial recupera pagos antiguos consumidos asociados a transacciones vigentes', async () => {
    rows = [
      makeIntent({ status: 'consumed', paymentTransactionId: 'transaction' }),
    ];
    expect(await suggest()).toEqual({ cuit: CUIT });
    expect(transactions.findMany).toHaveBeenCalledWith({
      where: {
        entryId: ENTRY,
        deletedAt: null,
        paymentMethodType: 'mercadopago_qr',
      },
      select: { id: true },
    });
  });

  it('ignora pagos eliminados o reemplazados', async () => {
    rows = [
      makeIntent({
        status: 'consumed',
        paymentTransactionId: 'old',
        payerCuit: CUIT,
        mpPaymentReferenceId: '123',
      }),
    ];
    expect(await suggest()).toEqual({ cuit: null });
    expect(mp.getOrder).not.toHaveBeenCalled();
  });

  it('no elige entre varios pagadores distintos', async () => {
    transactions.findMany.mockResolvedValue([
      { id: 'transaction' },
      { id: 'second' },
    ]);
    rows = [
      makeIntent({
        status: 'consumed',
        paymentTransactionId: 'transaction',
        payerCuit: CUIT,
        mpPaymentReferenceId: '123',
      }),
      makeIntent({
        id: 'second-intent',
        status: 'consumed',
        paymentTransactionId: 'second',
        payerCuit: OTHER_CUIT,
        mpPaymentReferenceId: '124',
      }),
    ];
    expect(await suggest()).toEqual({ cuit: null });
    rows[1].payerCuit = CUIT;
    expect(await suggest()).toEqual({ cuit: CUIT });
  });

  it('no devuelve un CUIT si se corrigio el pago durante la consulta', async () => {
    rows = [
      makeIntent({ status: 'consumed', paymentTransactionId: 'transaction' }),
    ];
    mp.getPayment.mockImplementation(() => {
      transactions.findMany.mockResolvedValue([]);
      return Promise.resolve(payment());
    });
    expect(await suggest()).toEqual({ cuit: null });
  });

  it('no devuelve un CUIT si falla la actualizacion condicional', async () => {
    intents.updateMany.mockResolvedValue({ count: 0 });
    expect(await suggest('intent')).toEqual({ cuit: null });
  });

  it('no convierte errores del proveedor en CUIT', async () => {
    mp.getPayment.mockRejectedValue(new Error('unreachable'));
    expect(
      await suggest('intent').catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
    expect(intents.updateMany).not.toHaveBeenCalled();
  });
});
