/* eslint-disable @typescript-eslint/await-thenable */
import { HttpStatus, Logger } from '@nestjs/common';
import * as fx from '../../mercado-pago/__fixtures__/checkout-pro.fixtures';
import type {
  MpApiClient,
  MpPayment,
  MpPreferenceBody,
} from '../../mercado-pago/mp-api.client';
import type { MpTokenService } from '../../mercado-pago/mp-token.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import {
  buildTitle,
  MercadoPagoCheckoutGateway,
} from './mercado-pago-checkout.gateway';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES_ID = fx.RESERVATION_ID;
const TOKEN = 'APP_USR-token-del-dueno';
const PUBLIC_URL = 'https://api.parkit.test';
const NOW = new Date('2026-10-10T11:00:00.000Z'); // 08:00 en Argentina

function mpPayment(overrides: Partial<MpPayment> = {}): MpPayment {
  return {
    id: '1234567890',
    status: 'approved',
    statusDetail: 'accredited',
    externalReference: RES_ID,
    transactionAmount: 1500,
    transactionAmountRefunded: 0,
    collectorId: '446566691',
    ...overrides,
  };
}

describe('MercadoPagoCheckoutGateway', () => {
  const api = {
    createPreference: jest.fn(),
    getPayment: jest.fn(),
    searchPayments: jest.fn(),
    refundPayment: jest.fn(),
    cancelPayment: jest.fn(),
  };
  const tokens = { getUsableAccessToken: jest.fn() };
  let gateway: MercadoPagoCheckoutGateway;
  let warnings: string[];

  const tokenProblem = (code: string) =>
    new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'x',
      '/x',
      code as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(api).forEach((fn) => fn.mockReset());
    tokens.getUsableAccessToken.mockReset();
    tokens.getUsableAccessToken.mockResolvedValue({ accessToken: TOKEN });
    warnings = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
    gateway = new MercadoPagoCheckoutGateway(
      api as unknown as MpApiClient,
      tokens as unknown as MpTokenService,
      PUBLIC_URL,
      () => NOW,
    );
  });

  describe('createCheckout', () => {
    const input = {
      reservation: { id: RES_ID },
      tenantId: TENANT,
      amountArs: 1500,
      // 15 minutos de retención: 08:15 en Argentina.
      expiresAt: new Date('2026-10-10T11:15:00.000Z'),
      returnUrl: 'parkit://reservas',
      description: {
        parkingName: 'Playa Centro',
        // 12:00–14:00 en Argentina.
        entryAt: new Date('2026-10-10T15:00:00.000Z'),
        exitAt: new Date('2026-10-10T17:00:00.000Z'),
      },
    };

    it('arma la preferencia exacta y devuelve preferenceId y checkoutUrl', async () => {
      api.createPreference.mockResolvedValue({
        id: 'PREF-1',
        initPoint: 'https://mp.test/checkout?pref_id=PREF-1',
      });

      const result = await gateway.createCheckout(input);

      expect(result).toEqual({
        preferenceId: 'PREF-1',
        checkoutUrl: 'https://mp.test/checkout?pref_id=PREF-1',
      });
      expect(tokens.getUsableAccessToken).toHaveBeenCalledWith(TENANT);

      const [token, body, key] = api.createPreference.mock.calls[0] as [
        string,
        MpPreferenceBody,
        string,
      ];
      expect(token).toBe(TOKEN);
      expect(body).toEqual({
        items: [
          {
            title: 'Reserva Playa Centro · 10/10 12:00–14:00',
            quantity: 1,
            unit_price: 1500,
            currency_id: 'ARS',
          },
        ],
        external_reference: RES_ID,
        notification_url:
          'https://api.parkit.test/integrations/mercadopago/webhook?source_news=webhooks',
        binary_mode: true,
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }] },
        expires: true,
        expiration_date_from: '2026-10-10T08:00:00.000-03:00',
        expiration_date_to: '2026-10-10T08:15:00.000-03:00',
        back_urls: {
          success: `https://api.parkit.test/payments/mp/return?reservation=${RES_ID}&result=success`,
          failure: `https://api.parkit.test/payments/mp/return?reservation=${RES_ID}&result=failure`,
          pending: `https://api.parkit.test/payments/mp/return?reservation=${RES_ID}&result=pending`,
        },
        auto_return: 'approved',
        marketplace_fee: 0,
      });
      // sha256 hex, determinístico para el mismo body.
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('la idempotency key es estable para el mismo pedido y cambia con el body', async () => {
      api.createPreference.mockResolvedValue({ id: 'P', initPoint: 'u' });

      await gateway.createCheckout(input);
      await gateway.createCheckout(input);
      await gateway.createCheckout({ ...input, amountArs: 2000 });

      const keys = api.createPreference.mock.calls.map((c) => c[2] as string);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('con la cuenta vencida no llega a crear la preferencia', async () => {
      tokens.getUsableAccessToken.mockRejectedValue(
        tokenProblem(ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED),
      );

      await expect(gateway.createCheckout(input)).rejects.toBeInstanceOf(
        FormattedException,
      );
      expect(api.createPreference).not.toHaveBeenCalled();
    });
  });

  describe('buildTitle', () => {
    const times = {
      entryAt: new Date('2026-10-10T15:00:00.000Z'),
      exitAt: new Date('2026-10-10T17:30:00.000Z'),
    };

    it('usa la hora argentina, no la del servidor', () => {
      // 02:00Z del día siguiente sigue siendo 23:00 del anterior en Argentina.
      expect(
        buildTitle({
          parkingName: 'P',
          entryAt: new Date('2026-10-11T02:00:00.000Z'),
          exitAt: new Date('2026-10-11T03:30:00.000Z'),
        }),
      ).toBe('Reserva P · 10/10 23:00–00:30');
    });

    it('recorta el nombre y nunca la fecha ni la hora', () => {
      const title = buildTitle({ parkingName: 'X'.repeat(500), ...times });
      expect(title).toHaveLength(150);
      expect(title.endsWith(' · 10/10 12:00–14:30')).toBe(true);
    });
  });

  describe('refund', () => {
    const input = {
      tenantId: TENANT,
      providerPaymentId: '1234567890',
      amountArs: 750,
      idempotencyKey: 'refund:res:1',
    };

    it('approved: queda refunded, con el token, la key y el monto', async () => {
      api.refundPayment.mockResolvedValue({
        id: '9',
        status: 'approved',
        amount: 750,
      });

      expect(await gateway.refund(input)).toEqual({
        status: 'refunded',
        amountArs: 750,
      });
      expect(api.refundPayment).toHaveBeenCalledWith(
        TOKEN,
        '1234567890',
        'refund:res:1',
        750,
      );
    });

    it('otro estado: queda pending', async () => {
      api.refundPayment.mockResolvedValue({
        id: '9',
        status: 'in_process',
        amount: null,
      });

      expect(await gateway.refund(input)).toEqual({
        status: 'pending',
        amountArs: 750,
      });
    });

    it('reembolso total: sin monto lo pide vacío y toma el de la respuesta', async () => {
      api.refundPayment.mockResolvedValue({
        id: '9',
        status: 'approved',
        amount: 1500,
      });

      expect(await gateway.refund({ ...input, amountArs: undefined })).toEqual({
        status: 'refunded',
        amountArs: 1500,
      });
      expect(api.refundPayment.mock.calls[0][3]).toBeUndefined();
    });

    it.each([
      [ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED, 'venció'],
      [ErrorCodes.MP_ACCOUNT_REVOKED, 'desvinculada'],
      [ErrorCodes.MP_NOT_LINKED, 'no tiene una cuenta'],
    ])(
      'token inservible (%s): Error en español para refundError',
      async (code, fragment) => {
        tokens.getUsableAccessToken.mockRejectedValue(tokenProblem(code));

        const error = await gateway.refund(input).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(FormattedException);
        expect((error as Error).message).toContain(fragment);
        expect(api.refundPayment).not.toHaveBeenCalled();
      },
    );

    it('si MP rechaza el reembolso, tira (el caller lo marca failed)', async () => {
      api.refundPayment.mockRejectedValue(
        tokenProblem(ErrorCodes.MP_REFUND_FAILED),
      );

      await expect(gateway.refund(input)).rejects.toBeInstanceOf(
        FormattedException,
      );
    });
  });

  describe('cancelPending', () => {
    const input = { tenantId: TENANT, reservationId: RES_ID };

    it('cancela solo los pagos pending e in_process', async () => {
      api.searchPayments.mockResolvedValue([
        mpPayment({ id: '1', status: 'pending' }),
        mpPayment({ id: '2', status: 'in_process' }),
        mpPayment({ id: '3', status: 'approved' }),
        mpPayment({ id: '4', status: 'rejected' }),
      ]);
      api.cancelPayment.mockResolvedValue(mpPayment({ status: 'cancelled' }));

      await gateway.cancelPending(input);

      expect(api.searchPayments).toHaveBeenCalledWith(TOKEN, {
        externalReference: RES_ID,
      });
      expect(
        (api.cancelPayment.mock.calls as string[][]).map((c) => [c[1], c[2]]),
      ).toEqual([
        ['1', 'cancel-payment:1'],
        ['2', 'cancel-payment:2'],
      ]);
    });

    it('nunca tira: un fallo del token o de la búsqueda se loguea', async () => {
      tokens.getUsableAccessToken.mockRejectedValue(new Error('sin token'));
      await expect(gateway.cancelPending(input)).resolves.toBeUndefined();

      tokens.getUsableAccessToken.mockResolvedValue({ accessToken: TOKEN });
      api.searchPayments.mockRejectedValue(new Error('MP caído'));
      await expect(gateway.cancelPending(input)).resolves.toBeUndefined();
      expect(warnings).toHaveLength(2);
    });

    it('si falla cancelar uno, sigue con el resto', async () => {
      api.searchPayments.mockResolvedValue([
        mpPayment({ id: '1', status: 'pending' }),
        mpPayment({ id: '2', status: 'pending' }),
      ]);
      api.cancelPayment
        .mockRejectedValueOnce(new Error('no se pudo'))
        .mockResolvedValueOnce(mpPayment({ status: 'cancelled' }));

      await gateway.cancelPending(input);

      expect(api.cancelPayment).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('getPayment: mapeo de estados con los fixtures', () => {
    const toMp = (raw: Record<string, unknown>): MpPayment => ({
      id: String(raw.id),
      status: raw.status as string,
      statusDetail: raw.status_detail as string,
      externalReference: raw.external_reference as string,
      transactionAmount: raw.transaction_amount as number,
      transactionAmountRefunded: raw.transaction_amount_refunded as number,
      collectorId: String(raw.collector_id),
    });

    it.each([
      ['approved', fx.paymentApproved, 'approved', 0],
      [
        'partially_refunded',
        fx.paymentPartiallyRefunded,
        'partially_refunded',
        750,
      ],
      ['refunded', fx.paymentRefunded, 'refunded', 1500],
      ['rejected', fx.paymentRejected, 'rejected', 0],
      ['cancelled', fx.paymentCancelled, 'cancelled', 0],
      ['pending', fx.paymentPending, 'pending', 0],
      ['in_process', fx.paymentInProcess, 'pending', 0],
    ])('%s', async (_name, raw, status, refunded) => {
      api.getPayment.mockResolvedValue(toMp(raw));

      expect(
        await gateway.getPayment({
          tenantId: TENANT,
          providerPaymentId: '1234567890',
        }),
      ).toMatchObject({
        providerPaymentId: '1234567890',
        status,
        amountArs: 1500,
        refundedAmountArs: refunded,
        externalReference: RES_ID,
      });
    });

    it('un aprobado con el monto entero devuelto es refunded', async () => {
      api.getPayment.mockResolvedValue(
        mpPayment({ status: 'approved', transactionAmountRefunded: 1500 }),
      );

      expect(
        (await gateway.getPayment({ tenantId: TENANT, providerPaymentId: '1' }))
          .status,
      ).toBe('refunded');
    });

    it('un estado desconocido (charged_back) no dispara nada: pending', async () => {
      api.getPayment.mockResolvedValue(mpPayment({ status: 'charged_back' }));

      expect(
        (await gateway.getPayment({ tenantId: TENANT, providerPaymentId: '1' }))
          .status,
      ).toBe('pending');
    });

    it('con el token vencido deja pasar el error para que decida quien llama', async () => {
      tokens.getUsableAccessToken.mockRejectedValue(
        tokenProblem(ErrorCodes.MP_ACCOUNT_TOKEN_EXPIRED),
      );

      await expect(
        gateway.getPayment({ tenantId: TENANT, providerPaymentId: '1' }),
      ).rejects.toBeInstanceOf(FormattedException);
    });
  });

  describe('findApprovedPayment', () => {
    const input = { tenantId: TENANT, reservationId: RES_ID };

    it('devuelve el aprobado más nuevo, salteando rechazados', async () => {
      api.searchPayments.mockResolvedValue([
        mpPayment({ id: '3', status: 'rejected' }),
        mpPayment({ id: '2', status: 'approved' }),
        mpPayment({ id: '1', status: 'approved' }),
      ]);

      expect(await gateway.findApprovedPayment(input)).toMatchObject({
        providerPaymentId: '2',
        status: 'approved',
      });
      expect(api.searchPayments).toHaveBeenCalledWith(TOKEN, {
        externalReference: RES_ID,
      });
    });

    it('un pago aprobado y devuelto en parte también prueba que se pagó', async () => {
      api.searchPayments.mockResolvedValue([
        mpPayment({ transactionAmountRefunded: 500 }),
      ]);

      expect((await gateway.findApprovedPayment(input))?.status).toBe(
        'partially_refunded',
      );
    });

    it('sin aprobados devuelve null', async () => {
      api.searchPayments.mockResolvedValue([
        mpPayment({ status: 'rejected' }),
        mpPayment({ status: 'pending' }),
      ]);
      expect(await gateway.findApprovedPayment(input)).toBeNull();

      api.searchPayments.mockResolvedValue([]);
      expect(await gateway.findApprovedPayment(input)).toBeNull();
    });
  });
});
