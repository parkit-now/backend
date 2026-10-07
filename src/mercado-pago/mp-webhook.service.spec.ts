import { HttpStatus, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentIntentStatus, Prisma } from '@prisma/client';
import type { PaymentIntent } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from '../reservations/payment-gateway/reservation-payment-gateway';
import { ReservationLifecycleService } from '../reservations/reservation-lifecycle.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
import { MpConfigService } from './mp-config.service';
import { MpSignatureService } from './mp-signature.service';
import { MpTokenService } from './mp-token.service';
import { MpWebhookService } from './mp-webhook.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const INTENT = '44444444-4444-7444-8444-444444444444';
const ORDER = 'ORD01K0';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const APPROVED_AT = new Date('2026-01-01T03:04:05.000Z');

describe('MpWebhookService', () => {
  let service: MpWebhookService;

  const prisma = {
    paymentIntent: { findFirst: jest.fn(), updateMany: jest.fn() },
    reservationPayment: { findFirst: jest.fn() },
    mpAccount: { findMany: jest.fn() },
  };
  const gateway = { getPayment: jest.fn() };
  const lifecycle = {
    markPaid: jest.fn(),
    markPaymentRejected: jest.fn(),
    confirmRefund: jest.fn(),
  };
  // La firma tiene su propio spec (`mp-signature.service.spec.ts`): acá sólo
  // importa qué hace el webhook con su veredicto.
  const signatures = { isValid: jest.fn() };
  const tokens = { getUsableAccessToken: jest.fn() };
  const mpApi = { getOrder: jest.fn() };
  const audit = { record: jest.fn() };

  const makeIntent = (
    overrides: Partial<PaymentIntent> = {},
  ): PaymentIntent => ({
    id: INTENT,
    tenantId: TENANT,
    entryId: '33333333-3333-7333-8333-333333333333',
    status: PaymentIntentStatus.pending,
    amount: new Prisma.Decimal('1500.00'),
    mpOrderId: ORDER,
    mpPaymentReferenceId: null,
    payerCuit: null,
    mpStatus: 'created',
    mpStatusDetail: 'created',
    expiresAt: EPOCH,
    approvedAt: null,
    consumedAt: null,
    paymentTransactionId: null,
    failureReason: null,
    createdByUserId: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  });

  /** Una notificación firmada, con el cuerpo crudo tal como lo deja el `raw`. */
  const notification = (body: Record<string, unknown>) => ({
    signatureHeader: 'ts=1767225845,v1=el-hash',
    requestId: 'req-1',
    dataId: ORDER,
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
  });

  const orderNotification = notification({
    type: 'order',
    action: 'order.processed',
    data: { id: ORDER },
  });

  /** El ProblemDetails de una promesa que TIENE que fallar. */
  const problemOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FormattedException);
      return (error as FormattedException).getResponse();
    }
    throw new Error('La promesa resolvió y tenía que fallar');
  };

  /** El único `updateMany` que se hizo. */
  const updateOf = (): {
    where: { status: { in: PaymentIntentStatus[] } };
    data: Record<string, unknown>;
  } =>
    prisma.paymentIntent.updateMany.mock.calls[0][0] as {
      where: { status: { in: PaymentIntentStatus[] } };
      data: Record<string, unknown>;
    };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MpWebhookService,
        { provide: PrismaService, useValue: prisma },
        { provide: MpSignatureService, useValue: signatures },
        { provide: MpTokenService, useValue: tokens },
        { provide: MpApiClient, useValue: mpApi },
        { provide: AuditService, useValue: audit },
        { provide: RESERVATION_PAYMENT_GATEWAY, useValue: gateway },
        { provide: ReservationLifecycleService, useValue: lifecycle },
      ],
    }).compile();

    service = module.get<MpWebhookService>(MpWebhookService);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    signatures.isValid.mockReturnValue(true);
    prisma.paymentIntent.findFirst.mockResolvedValue(makeIntent());
    prisma.paymentIntent.updateMany.mockResolvedValue({ count: 1 });
    tokens.getUsableAccessToken.mockResolvedValue({
      accessToken: 'access-token-en-plano',
    });
    // 🔴 El estado sale de ACÁ, de releer la orden, y NUNCA del cuerpo: el
    // cuerpo no está cubierto por la firma.
    mpApi.getOrder.mockResolvedValue({
      id: ORDER,
      status: 'processed',
      statusDetail: 'accredited',
      externalReference: INTENT,
      lastUpdatedDate: APPROVED_AT,
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('firma inválida: 401 y NO toca la base', async () => {
    signatures.isValid.mockReturnValue(false);

    expect(await problemOf(service.handle(orderNotification))).toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
    expect(prisma.paymentIntent.findFirst).not.toHaveBeenCalled();
    expect(mpApi.getOrder).not.toHaveBeenCalled();
  });

  it('un tópico que no es `order`: no-op y 200', async () => {
    // Un error acá sería Mercado Pago reintentando cada 15 minutos para
    // siempre por un evento que decidimos ignorar.
    await service.handle(
      notification({ type: 'payment', action: 'payment.created' }),
    );

    expect(prisma.paymentIntent.findFirst).not.toHaveBeenCalled();
  });

  it('orden desconocida: no-op y 200 (puede no ser nuestra)', async () => {
    prisma.paymentIntent.findFirst.mockResolvedValue(null);

    await service.handle(orderNotification);

    expect(mpApi.getOrder).not.toHaveBeenCalled();
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('MP dice `processed`: el intent pasa a approved con el approvedAt de MP', async () => {
    await service.handle(orderNotification);

    expect(mpApi.getOrder).toHaveBeenCalledWith('access-token-en-plano', ORDER);
    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: INTENT,
        tenantId: TENANT,
        status: {
          in: [
            PaymentIntentStatus.created,
            PaymentIntentStatus.pending,
            PaymentIntentStatus.expired,
          ],
        },
      },
      data: {
        status: PaymentIntentStatus.approved,
        mpStatus: 'processed',
        mpStatusDetail: 'accredited',
        // El instante de MP, no el nuestro: entre el pago y la notificación
        // pueden pasar minutos.
        approvedAt: APPROVED_AT,
      },
    });
  });

  it('`processed` sobre un intent ya approved: count 0 y sin error', async () => {
    prisma.paymentIntent.findFirst.mockResolvedValue(
      makeIntent({
        status: PaymentIntentStatus.approved,
        approvedAt: APPROVED_AT,
      }),
    );
    prisma.paymentIntent.updateMany.mockResolvedValue({ count: 0 });

    // Mercado Pago reintenta la misma notificación: la guarda no matchea,
    // nadie actualiza nada, y eso es lo normal, no un fallo.
    await service.handle(orderNotification);

    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledTimes(1);
  });

  it('`processed` sobre un intent expired: lo aprueba igual, la plata le gana al reloj', async () => {
    // Nuestro `expired` lo escribió la expiración perezosa con NUESTRO reloj;
    // el pago es un hecho. Si `expired` fuera terminal, la estadía cerraría
    // como impaga con la plata del cliente ya cobrada.
    prisma.paymentIntent.findFirst.mockResolvedValue(
      makeIntent({ status: PaymentIntentStatus.expired }),
    );

    await service.handle(orderNotification);

    expect(updateOf().where.status.in).toContain(PaymentIntentStatus.expired);
    expect(updateOf().data.status).toBe(PaymentIntentStatus.approved);
  });
});

describe('MpWebhookService: pagos de reservas', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const RESERVATION = '55555555-5555-7555-8555-555555555555';
  const PAYMENT = '123456789';
  const MP_USER = '987654';

  const prisma = {
    paymentIntent: { findFirst: jest.fn(), updateMany: jest.fn() },
    reservationPayment: { findFirst: jest.fn() },
    mpAccount: { findMany: jest.fn() },
  };
  const signatures = { isValid: jest.fn() };
  const gateway = { getPayment: jest.fn() };
  const lifecycle = {
    markPaid: jest.fn(),
    markPaymentRejected: jest.fn(),
    confirmRefund: jest.fn(),
  };

  const service = new MpWebhookService(
    prisma as unknown as PrismaService,
    signatures as unknown as MpSignatureService,
    {} as unknown as MpTokenService,
    {} as unknown as MpApiClient,
    {} as unknown as AuditService,
    gateway as unknown as ReservationPaymentGateway,
    lifecycle as unknown as ReservationLifecycleService,
  );

  const payment = (overrides: Record<string, unknown> = {}) => ({
    providerPaymentId: PAYMENT,
    status: 'approved',
    amountArs: 1000,
    refundedAmountArs: 0,
    externalReference: RESERVATION,
    ...overrides,
  });

  const paymentNotification = (
    extra: Record<string, unknown> = {},
    body: Record<string, unknown> = {
      type: 'payment',
      data: { id: PAYMENT },
      user_id: Number(MP_USER),
    },
  ) => ({
    signatureHeader: 'ts=1,v1=x',
    requestId: 'req-1',
    dataId: PAYMENT,
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    ...extra,
  });

  /** El status HTTP de una promesa que TIENE que fallar. */
  const statusOf = async (promise: Promise<unknown>): Promise<number> => {
    try {
      await promise;
    } catch (error) {
      return (error as FormattedException).getStatus();
    }
    throw new Error('La promesa resolvió y tenía que fallar');
  };

  const failWith = (code: string, status: number) =>
    new FormattedException('x', status, 'detalle', '/x', code as never);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    signatures.isValid.mockReturnValue(true);
    // Primer aviso: el pago todavía no está en `reservation_payments` (se lo
    // busca por `providerPaymentId`), pero la reserva sí (por `reservationId`).
    prisma.reservationPayment.findFirst.mockImplementation(
      ({ where }: { where: { providerPaymentId?: string } }) =>
        Promise.resolve(
          where.providerPaymentId
            ? null
            : { reservationId: RESERVATION, tenantId: TENANT },
        ),
    );
    prisma.mpAccount.findMany.mockResolvedValue([{ tenantId: TENANT }]);
    gateway.getPayment.mockResolvedValue(payment());
    lifecycle.markPaid.mockResolvedValue({ outcome: 'confirmed' });
    lifecycle.confirmRefund.mockResolvedValue({ outcome: 'refunded' });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('approved: resuelve la playa por user_id, lee el pago y confirma la reserva', async () => {
    await service.handle(paymentNotification());

    expect(prisma.mpAccount.findMany).toHaveBeenCalledWith({
      where: { mpUserId: MP_USER, status: 'linked' },
      select: { tenantId: true },
    });
    expect(gateway.getPayment).toHaveBeenCalledWith({
      tenantId: TENANT,
      providerPaymentId: PAYMENT,
    });
    expect(lifecycle.markPaid).toHaveBeenCalledWith(RESERVATION, {
      providerPaymentId: PAYMENT,
      providerStatus: 'approved',
      providerStatusDetail: undefined,
    });
  });

  it('un pago ya conocido se resuelve por su fila, sin mirar las cuentas', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue({
      reservationId: RESERVATION,
      tenantId: TENANT,
    });

    await service.handle(paymentNotification({}, { type: 'payment' }));

    expect(prisma.mpAccount.findMany).not.toHaveBeenCalled();
    expect(lifecycle.markPaid).toHaveBeenCalledTimes(1);
  });

  it('approved duplicado: el ciclo de vida lo ignora y el webhook igual contesta 200', async () => {
    lifecycle.markPaid.mockResolvedValue({ outcome: 'ignored' });

    await service.handle(paymentNotification());
    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).toHaveBeenCalledTimes(2);
  });

  it('rejected tardío, después de un approved: se delega y no tira', async () => {
    gateway.getPayment.mockResolvedValue(
      payment({ status: 'rejected', statusDetail: 'cc_rejected_other' }),
    );

    await service.handle(paymentNotification());

    expect(lifecycle.markPaymentRejected).toHaveBeenCalledWith(RESERVATION, {
      providerPaymentId: PAYMENT,
      providerStatusDetail: 'cc_rejected_other',
      providerStatus: 'rejected',
    });
    expect(lifecycle.markPaid).not.toHaveBeenCalled();
  });

  it('pago tardío (reserva cancelada): markPaid devuelve refunded_after_cancel y contesta 200', async () => {
    lifecycle.markPaid.mockResolvedValue({ outcome: 'refunded_after_cancel' });

    await service.handle(paymentNotification());
  });

  it('pago ajeno a reservas (QR u otra app): se ignora con 200', async () => {
    gateway.getPayment.mockResolvedValue(payment({ externalReference: null }));

    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).not.toHaveBeenCalled();
    expect(prisma.reservationPayment.findFirst).toHaveBeenCalledTimes(1);
  });

  it('un external_reference que no es de una reserva nuestra se ignora', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue(null);

    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).not.toHaveBeenCalled();
  });

  it('un user_id sin cuentas vinculadas: 200 sin leer nada', async () => {
    prisma.mpAccount.findMany.mockResolvedValue([]);

    await service.handle(paymentNotification());

    expect(gateway.getPayment).not.toHaveBeenCalled();
  });

  it('IPN legacy sin firma: 200 y se ignora (no es 401)', async () => {
    await service.handle({
      signatureHeader: null,
      dataId: null,
      queryTopic: 'payment',
      queryId: PAYMENT,
      rawBody: Buffer.alloc(0),
    });

    expect(signatures.isValid).not.toHaveBeenCalled();
    expect(gateway.getPayment).not.toHaveBeenCalled();
  });

  it('sin firma y sin formato IPN sigue siendo 401', async () => {
    signatures.isValid.mockReturnValue(false);

    expect(
      await statusOf(
        service.handle({ signatureHeader: null, rawBody: Buffer.alloc(0) }),
      ),
    ).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('contracargo: 200 sin tocar nada', async () => {
    await service.handle(
      paymentNotification(
        {},
        { type: 'topic_chargebacks_wh', data: { id: 'c1' } },
      ),
    );

    expect(gateway.getPayment).not.toHaveBeenCalled();
    expect(lifecycle.markPaid).not.toHaveBeenCalled();
  });

  it('el tópico puede venir sólo en la query (type=payment)', async () => {
    await service.handle(
      paymentNotification({ queryType: 'payment' }, { user_id: MP_USER }),
    );

    expect(lifecycle.markPaid).toHaveBeenCalledTimes(1);
  });

  it('reembolso parcial: confirma el pago y el monto devuelto', async () => {
    gateway.getPayment.mockResolvedValue(
      payment({ status: 'partially_refunded', refundedAmountArs: 400 }),
    );
    lifecycle.confirmRefund.mockResolvedValue({ outcome: 'partial' });

    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).toHaveBeenCalledTimes(1);
    expect(lifecycle.confirmRefund).toHaveBeenCalledWith(RESERVATION, {
      refundedAmountArs: 400,
      providerPaymentId: PAYMENT,
    });
  });

  it('reembolso total: usa el monto devuelto, o el cobrado si MP no lo informa', async () => {
    gateway.getPayment.mockResolvedValue(
      payment({ status: 'refunded', refundedAmountArs: 0 }),
    );

    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).not.toHaveBeenCalled();
    expect(lifecycle.confirmRefund).toHaveBeenCalledWith(RESERVATION, {
      refundedAmountArs: 1000,
      providerPaymentId: PAYMENT,
    });
  });

  it('pending y cancelled: sólo se loguea', async () => {
    gateway.getPayment.mockResolvedValue(payment({ status: 'pending' }));
    await service.handle(paymentNotification());
    gateway.getPayment.mockResolvedValue(payment({ status: 'cancelled' }));
    await service.handle(paymentNotification());

    expect(lifecycle.markPaid).not.toHaveBeenCalled();
    expect(lifecycle.markPaymentRejected).not.toHaveBeenCalled();
    expect(lifecycle.confirmRefund).not.toHaveBeenCalled();
  });

  it('Mercado Pago caído: 503 para que reintente', async () => {
    gateway.getPayment.mockRejectedValue(
      failWith(ErrorCodes.MP_UNAVAILABLE, 503),
    );
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );

    gateway.getPayment.mockRejectedValue(
      failWith(ErrorCodes.MP_UNREACHABLE, 502),
    );
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('token vencido: 200 (el barrido recupera el pago)', async () => {
    gateway.getPayment.mockRejectedValue(
      failWith(ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED, 409),
    );

    await service.handle(paymentNotification());
    expect(lifecycle.markPaid).not.toHaveBeenCalled();
  });

  it('fallo inesperado del ciclo de vida (p. ej. la base): 503 para que reintente', async () => {
    lifecycle.markPaid.mockRejectedValue(new Error('db down'));
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );

    gateway.getPayment.mockResolvedValue(
      payment({ status: 'rejected', statusDetail: 'cc_rejected_other' }),
    );
    lifecycle.markPaymentRejected.mockRejectedValue(new Error('db down'));
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );

    gateway.getPayment.mockResolvedValue(payment({ status: 'refunded' }));
    lifecycle.confirmRefund.mockRejectedValue(new Error('db down'));
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('un 5xx del ciclo de vida también pide reintento', async () => {
    lifecycle.markPaid.mockRejectedValue(failWith('X', 500));
    expect(await statusOf(service.handle(paymentNotification()))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('4xx esperado del ciclo de vida (409 de estado, 404): 200 sin reintento', async () => {
    lifecycle.markPaid.mockRejectedValue(failWith('RESERVATION_CONFLICT', 409));
    await service.handle(paymentNotification());

    lifecycle.markPaid.mockRejectedValue(
      failWith(ErrorCodes.RESERVATION_NOT_FOUND, 404),
    );
    await service.handle(paymentNotification());
    expect(lifecycle.markPaid).toHaveBeenCalledTimes(2);
  });

  it('error de token al aplicar (cuenta desvinculada): 200', async () => {
    lifecycle.markPaid.mockRejectedValue(
      failWith(ErrorCodes.MP_ACCOUNT_REVOKED, 409),
    );
    await service.handle(paymentNotification());
  });

  it('fallo inesperado ANTES de identificar la reserva: 200', async () => {
    gateway.getPayment.mockRejectedValue(new Error('boom'));
    await service.handle(paymentNotification());
    expect(lifecycle.markPaid).not.toHaveBeenCalled();
  });

  describe('con la firma REAL', () => {
    const SECRET = 'secreto-de-prueba-del-webhook';
    const sign = (dataId: string, requestId: string, ts: string) =>
      createHmac('sha256', SECRET)
        .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`)
        .digest('hex');

    const real = new MpWebhookService(
      prisma as unknown as PrismaService,
      new MpSignatureService({
        webhookSecret: SECRET,
      } as unknown as MpConfigService),
      {} as unknown as MpTokenService,
      {} as unknown as MpApiClient,
      {} as unknown as AuditService,
      gateway as unknown as ReservationPaymentGateway,
      lifecycle as unknown as ReservationLifecycleService,
    );

    const NOW = new Date('2026-10-04T12:00:00.000Z');
    const TS = String(NOW.getTime() / 1000);

    it('una notificación bien firmada confirma el pago de punta a punta', async () => {
      await real.handle({
        ...paymentNotification(),
        signatureHeader: `ts=${TS},v1=${sign(PAYMENT, 'req-1', TS)}`,
        now: NOW,
      });

      expect(lifecycle.markPaid).toHaveBeenCalledWith(
        RESERVATION,
        expect.objectContaining({ providerPaymentId: PAYMENT }),
      );
    });

    it('con la firma de otro secreto: 401 y no se lee nada', async () => {
      const forged = createHmac('sha256', 'otro-secreto')
        .update(`id:${PAYMENT};request-id:req-1;ts:${TS};`)
        .digest('hex');

      expect(
        await statusOf(
          real.handle({
            ...paymentNotification(),
            signatureHeader: `ts=${TS},v1=${forged}`,
            now: NOW,
          }),
        ),
      ).toBe(HttpStatus.UNAUTHORIZED);
      expect(gateway.getPayment).not.toHaveBeenCalled();
      expect(lifecycle.markPaid).not.toHaveBeenCalled();
    });
  });
});
