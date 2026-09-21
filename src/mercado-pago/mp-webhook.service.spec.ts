import { HttpStatus, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentIntentStatus, Prisma } from '@prisma/client';
import type { PaymentIntent } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
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
