import { Test, TestingModule } from '@nestjs/testing';
import { PaymentIntentStatus, Prisma, UserRole } from '@prisma/client';
import type { Entry, MpAccount, PaymentIntent, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
import { MpTokenService } from './mp-token.service';
import { PaymentIntentsService } from './payment-intents.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const ENTRY = '33333333-3333-7333-8333-333333333333';
const INTENT = '44444444-4444-7444-8444-444444444444';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

describe('PaymentIntentsService', () => {
  let service: PaymentIntentsService;

  const prisma = {
    paymentIntent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    entry: { findFirst: jest.fn() },
  };
  const audit = { record: jest.fn() };
  // Mockeado: el ciclo de vida del token lo cubre `mp-token.service.spec.ts`.
  // Acá sólo importa que el cobro le pida el token a ÉL.
  const tokens = { getUsableAccessToken: jest.fn() };
  const mpApi = { createOrder: jest.fn(), cancelOrder: jest.fn() };

  /**
   * Orden real de las llamadas que importan. El test del camino feliz afirma
   * que la fila se persiste ANTES de hablar con Mercado Pago, y eso es una
   * propiedad del ORDEN, no de los argumentos: con asserts sueltos pasaría
   * igual si alguien invirtiera los dos pasos.
   */
  let calls: string[];

  const user: User = {
    id: USER,
    role: UserRole.user,
    email: 'operario@parkit.test',
    name: 'Operario',
    createdAt: EPOCH,
  };

  const openEntry = { id: ENTRY, tenantId: TENANT, leftAt: null } as Entry;

  const account = {
    tenantId: TENANT,
    externalPosId: 'PARKITPOS1111',
  } as MpAccount;

  const makeIntent = (
    overrides: Partial<PaymentIntent> = {},
  ): PaymentIntent => ({
    id: INTENT,
    tenantId: TENANT,
    entryId: ENTRY,
    status: PaymentIntentStatus.created,
    amount: new Prisma.Decimal('1500.00'),
    mpOrderId: null,
    mpPaymentReferenceId: null,
    payerCuit: null,
    mpStatus: null,
    mpStatusDetail: null,
    expiresAt: new Date(Date.now() + 300_000),
    approvedAt: null,
    consumedAt: null,
    paymentTransactionId: null,
    failureReason: null,
    createdByUserId: USER,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  });

  /** Devuelve el ProblemDetails de una promesa que TIENE que fallar. */
  const problemOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(FormattedException);
      return (error as FormattedException).getResponse();
    }
    throw new Error('La promesa resolvió y tenía que fallar');
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentIntentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MpTokenService, useValue: tokens },
        { provide: MpApiClient, useValue: mpApi },
      ],
    }).compile();

    service = module.get<PaymentIntentsService>(PaymentIntentsService);
    jest.clearAllMocks();
    calls = [];

    // Defaults del camino feliz; cada test sobreescribe sólo lo suyo.
    prisma.paymentIntent.findUnique.mockResolvedValue(null);
    prisma.paymentIntent.updateMany.mockResolvedValue({ count: 1 });
    prisma.paymentIntent.count.mockResolvedValue(0);
    prisma.entry.findFirst.mockResolvedValue(openEntry);
    tokens.getUsableAccessToken.mockResolvedValue({
      account,
      accessToken: 'access-token-en-plano',
    });
    prisma.paymentIntent.create.mockImplementation(() => {
      calls.push('db.create');
      return Promise.resolve(makeIntent());
    });
    mpApi.createOrder.mockImplementation(() => {
      calls.push('mp.createOrder');
      return Promise.resolve({
        id: 'MP-ORDER-1',
        status: 'created',
        statusDetail: 'created',
        externalReference: INTENT,
      });
    });
  });

  describe('create', () => {
    it('persiste la fila ANTES de llamar a MP, guarda el mpOrderId y queda pending', async () => {
      prisma.paymentIntent.findFirst.mockResolvedValue(
        makeIntent({
          status: PaymentIntentStatus.pending,
          mpOrderId: 'MP-ORDER-1',
        }),
      );

      const result = await service.create(TENANT, user, {
        id: INTENT,
        entryId: ENTRY,
        amount: 1500,
      });

      // Lo importante del camino feliz: si MP muere por timeout, la fila en
      // `created` ya existe y es lo único que permite recuperarse.
      expect(calls).toEqual(['db.create', 'mp.createOrder']);
      const created = prisma.paymentIntent.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(created.data).toMatchObject({
        id: INTENT,
        tenantId: TENANT,
        entryId: ENTRY,
        status: PaymentIntentStatus.created,
        createdByUserId: USER,
      });
      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: { id: INTENT, tenantId: TENANT },
        data: {
          mpOrderId: 'MP-ORDER-1',
          mpStatus: 'created',
          mpStatusDetail: 'created',
        },
      });
      expect(result.status).toBe(PaymentIntentStatus.pending);
      expect(result.mpOrderId).toBe('MP-ORDER-1');
    });

    it('el external_code del ítem entra en el tope de 30 de MP y sale sólo del entryId', async () => {
      // 🔴 El bug de producción: el UUID entero son 36 caracteres y MP contesta
      // `400 ... length must be <= 30, but got 36`. Sacarle los guiones da 32,
      // que TAMPOCO entra: hay que truncar.
      const entryId = '0199c3ab-7f4e-7a1b-9c2d-5e6f70819abc';
      prisma.paymentIntent.create.mockResolvedValue(makeIntent({ entryId }));

      await service.create(TENANT, user, {
        id: INTENT,
        entryId,
        amount: 1500,
      });

      const [, input] = mpApi.createOrder.mock.calls[0] as [
        string,
        { items: { externalCode: string }[] },
      ];

      // Prefijo del UUID sin guiones y en mayúsculas: 30 caracteres hex, y
      // sigue siendo reconocible a ojo contra la estadía desde el panel de MP.
      expect(input.items[0].externalCode).toBe(
        '0199C3AB7F4E7A1B9C2D5E6F70819A',
      );
    });

    it('re-POST con el mismo id devuelve el existente y NO vuelve a crear la order', async () => {
      const already = makeIntent({
        status: PaymentIntentStatus.pending,
        mpOrderId: 'MP-ORDER-1',
      });
      prisma.paymentIntent.findUnique.mockResolvedValue(already);

      const result = await service.create(TENANT, user, {
        id: INTENT,
        entryId: ENTRY,
        amount: 1500,
      });

      expect(result.id).toBe(INTENT);
      expect(result.status).toBe(PaymentIntentStatus.pending);
      expect(mpApi.createOrder).not.toHaveBeenCalled();
      expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
    });

    it('si MP RECHAZA la order (4xx), el intent queda failed con motivo y la fila NO se borra', async () => {
      // `MP_ORDER_CREATE_FAILED` es el code que `MpApiClient` emite sólo cuando
      // Mercado Pago contestó y rechazó: la orden NO existe, así que el intento
      // es terminal y la caja queda libre.
      mpApi.createOrder.mockRejectedValue(
        new FormattedException(
          'Bad Gateway',
          502,
          'Mercado Pago returned 400',
          '/tenants/:tenantId/payment-intents',
          ErrorCodes.MP_ORDER_CREATE_FAILED,
        ),
      );

      const problem = await problemOf(
        service.create(TENANT, user, {
          id: INTENT,
          entryId: ENTRY,
          amount: 1500,
        }),
      );

      // El error de Mercado Pago se propaga tal cual, no se traga.
      expect(problem).toMatchObject({
        code: ErrorCodes.MP_ORDER_CREATE_FAILED,
      });
      // La fila existe y NO se borra: es el rastro de que se intentó cobrar.
      expect(prisma.paymentIntent.create).toHaveBeenCalledTimes(1);
      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTENT,
          tenantId: TENANT,
          status: { in: [PaymentIntentStatus.created] },
        },
        data: {
          status: PaymentIntentStatus.failed,
          failureReason: 'MP_ORDER_CREATE_FAILED (HTTP 502)',
        },
      });
    });

    it('si MP no contesta, el intent SE QUEDA en created: la orden puede existir', async () => {
      // 🔴 El caso caro. Con un timeout no sabemos si `POST /v1/orders` llegó.
      // Marcarlo `failed` lo saca de `payment_intents_tenant_live_idx`, el
      // operario cobra el auto siguiente contra el MISMO cartel impreso y un
      // cliente termina pagando el monto del otro auto.
      mpApi.createOrder.mockRejectedValue(
        new FormattedException(
          'Bad Gateway',
          502,
          'Could not reach Mercado Pago',
          '/tenants/:tenantId/payment-intents',
          ErrorCodes.MP_UNREACHABLE,
        ),
      );

      const problem = await problemOf(
        service.create(TENANT, user, {
          id: INTENT,
          entryId: ENTRY,
          amount: 1500,
        }),
      );

      expect(problem).toMatchObject({ code: ErrorCodes.MP_UNREACHABLE });
      // Se anota el motivo —lo necesita el reconciliador— pero NO se toca el
      // estado: `created` es justamente "la orden puede o no existir".
      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTENT,
          tenantId: TENANT,
          status: { in: [PaymentIntentStatus.created] },
        },
        data: { failureReason: 'MP_UNREACHABLE (HTTP 502)' },
      });
    });
  });

  describe('getById', () => {
    it('vencido y pending: lo pasa a expired (expiración perezosa)', async () => {
      const stale = makeIntent({
        status: PaymentIntentStatus.pending,
        mpOrderId: 'MP-ORDER-1',
        expiresAt: new Date(Date.now() - 1_000),
      });
      prisma.paymentIntent.findFirst
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce({
          ...stale,
          status: PaymentIntentStatus.expired,
        });

      const result = await service.getById(TENANT, INTENT);

      expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
        where: {
          id: INTENT,
          tenantId: TENANT,
          status: {
            in: [PaymentIntentStatus.created, PaymentIntentStatus.pending],
          },
        },
        data: { status: PaymentIntentStatus.expired },
      });
      expect(result.status).toBe(PaymentIntentStatus.expired);
    });

    it('vencido pero approved: NO lo toca, la plata le gana al reloj', async () => {
      prisma.paymentIntent.findFirst.mockResolvedValue(
        makeIntent({
          status: PaymentIntentStatus.approved,
          mpOrderId: 'MP-ORDER-1',
          approvedAt: EPOCH,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );

      const result = await service.getById(TENANT, INTENT);

      expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe(PaymentIntentStatus.approved);
    });
  });

  describe('cancel', () => {
    it('desde pending con mpOrderId: cancela también en MP y queda canceled', async () => {
      prisma.paymentIntent.findFirst
        .mockResolvedValueOnce(
          makeIntent({
            status: PaymentIntentStatus.pending,
            mpOrderId: 'MP-ORDER-1',
          }),
        )
        .mockResolvedValueOnce(
          makeIntent({
            status: PaymentIntentStatus.canceled,
            mpOrderId: 'MP-ORDER-1',
          }),
        );
      mpApi.cancelOrder.mockResolvedValue({
        id: 'MP-ORDER-1',
        status: 'canceled',
        statusDetail: 'canceled',
        externalReference: INTENT,
      });

      const result = await service.cancel(TENANT, INTENT, user);

      // Si la orden quedara viva en la caja, el próximo cliente que escanee el
      // cartel impreso pagaría el monto del auto anterior.
      expect(mpApi.cancelOrder).toHaveBeenCalledWith(
        'access-token-en-plano',
        'MP-ORDER-1',
        expect.any(String),
      );
      expect(result.status).toBe(PaymentIntentStatus.canceled);
    });

    it('desde consumed: 409 y no toca Mercado Pago', async () => {
      prisma.paymentIntent.findFirst.mockResolvedValue(
        makeIntent({
          status: PaymentIntentStatus.consumed,
          mpOrderId: 'MP-ORDER-1',
          consumedAt: EPOCH,
        }),
      );

      const problem = await problemOf(service.cancel(TENANT, INTENT, user));

      expect(problem).toMatchObject({
        status: 409,
        code: ErrorCodes.PAYMENT_INTENT_NOT_CANCELABLE,
      });
      expect(mpApi.cancelOrder).not.toHaveBeenCalled();
      expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
    });
  });
});
