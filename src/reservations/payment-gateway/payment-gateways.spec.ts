/* eslint-disable @typescript-eslint/await-thenable */
import { HttpStatus } from '@nestjs/common';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { DevCheckoutGateway, devPaymentId } from './dev-checkout.gateway';
import { FakeReservationPaymentGateway } from './fake-reservation-payment.gateway';
import {
  createReservationPaymentGateway,
  resolveReservationPaymentProvider,
} from './reservation-payment.provider';
import type { ReservationPaymentGateway } from './reservation-payment-gateway';
import { UnavailableMercadoPagoGateway } from './unavailable-mercado-pago.gateway';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES_ID = '0192f0a0-0000-7000-8000-00000000abcd';
const checkoutInput = {
  reservation: { id: RES_ID },
  tenantId: TENANT,
  amountArs: 9000,
  expiresAt: new Date('2026-09-27T16:10:00Z'),
  returnUrl: 'parkit://reservas',
};

describe('DevCheckoutGateway', () => {
  const gateway = new DevCheckoutGateway('http://localhost:3000');

  it('el checkout apunta a la página de dev de la API', async () => {
    expect(await gateway.createCheckout(checkoutInput)).toEqual({
      preferenceId: `dev_pref_${RES_ID}`,
      checkoutUrl: `http://localhost:3000/dev/checkout/${RES_ID}`,
    });
  });

  it('el reembolso se confirma al instante', async () => {
    expect(
      await gateway.refund({
        tenantId: TENANT,
        providerPaymentId: devPaymentId(false),
        amountArs: 4500,
        idempotencyKey: 'refund:x:1',
      }),
    ).toEqual({ status: 'refunded', amountArs: 4500 });
  });

  it('el reembolso de un pago devfail_ tira', async () => {
    const paymentId = devPaymentId(true);
    expect(paymentId.startsWith('devfail_')).toBe(true);
    await expect(
      gateway.refund({
        tenantId: TENANT,
        providerPaymentId: paymentId,
        amountArs: 4500,
        idempotencyKey: 'refund:x:1',
      }),
    ).rejects.toThrow('devfail_');
  });

  it('los ids de pago de dev llevan el prefijo dev_', () => {
    expect(devPaymentId(false).startsWith('dev_')).toBe(true);
  });

  it('sin base explícita usa PUBLIC_API_URL o localhost:PORT', async () => {
    const previous = { ...process.env };
    try {
      process.env.PUBLIC_API_URL = 'https://api.local/';
      expect(
        (await new DevCheckoutGateway().createCheckout(checkoutInput))
          .checkoutUrl,
      ).toBe(`https://api.local/dev/checkout/${RES_ID}`);

      delete process.env.PUBLIC_API_URL;
      process.env.PORT = '4000';
      expect(
        (await new DevCheckoutGateway().createCheckout(checkoutInput))
          .checkoutUrl,
      ).toBe(`http://localhost:4000/dev/checkout/${RES_ID}`);
    } finally {
      process.env = previous;
    }
  });
});

describe('UnavailableMercadoPagoGateway', () => {
  const gateway: ReservationPaymentGateway =
    new UnavailableMercadoPagoGateway();

  it('createCheckout responde 503 RESERVATION_CHECKOUT_UNAVAILABLE', async () => {
    const promise = gateway.createCheckout(checkoutInput);
    await expect(promise).rejects.toBeInstanceOf(FormattedException);
    await expect(promise).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: expect.objectContaining({
        code: 'RESERVATION_CHECKOUT_UNAVAILABLE',
      }) as unknown,
    });
  });

  it('el reembolso falla para que quede reintentable', async () => {
    await expect(
      gateway.refund({
        tenantId: TENANT,
        providerPaymentId: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow();
  });
});

describe('FakeReservationPaymentGateway', () => {
  it('registra las llamadas y permite forzar fallas', async () => {
    const gateway = new FakeReservationPaymentGateway();
    const checkout = await gateway.createCheckout(checkoutInput);
    expect(checkout.checkoutUrl).toContain(RES_ID);
    expect(gateway.checkouts).toHaveLength(1);

    gateway.nextRefundError = new Error('sin saldo');
    await expect(
      gateway.refund({
        tenantId: TENANT,
        providerPaymentId: 'p',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('sin saldo');
    expect(gateway.refunds).toHaveLength(1);
  });
});

describe('resolveReservationPaymentProvider', () => {
  it('por defecto: dev fuera de producción, mercado_pago en producción', () => {
    expect(resolveReservationPaymentProvider(undefined, false)).toBe('dev');
    expect(resolveReservationPaymentProvider('', false)).toBe('dev');
    expect(resolveReservationPaymentProvider(undefined, true)).toBe(
      'mercado_pago',
    );
  });

  it('respeta la variable explícita', () => {
    expect(resolveReservationPaymentProvider('mercado_pago', false)).toBe(
      'mercado_pago',
    );
    expect(resolveReservationPaymentProvider('mercado_pago', true)).toBe(
      'mercado_pago',
    );
    expect(resolveReservationPaymentProvider('dev', false)).toBe('dev');
  });

  it('en producción, dev falla el arranque', () => {
    expect(() => resolveReservationPaymentProvider('dev', true)).toThrow(
      'NODE_ENV=production',
    );
  });

  it('un valor desconocido falla', () => {
    expect(() => resolveReservationPaymentProvider('stripe', false)).toThrow(
      'inválido',
    );
  });

  it('arma el gateway que corresponde', () => {
    expect(createReservationPaymentGateway('dev')).toBeInstanceOf(
      DevCheckoutGateway,
    );
    expect(createReservationPaymentGateway('mercado_pago')).toBeInstanceOf(
      UnavailableMercadoPagoGateway,
    );
  });
});
