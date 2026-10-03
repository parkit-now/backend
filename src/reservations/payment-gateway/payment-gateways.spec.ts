/* eslint-disable @typescript-eslint/await-thenable */
import type { MpApiClient } from '../../mercado-pago/mp-api.client';
import type { MpTokenService } from '../../mercado-pago/mp-token.service';
import { DevCheckoutGateway, devPaymentId } from './dev-checkout.gateway';
import { FakeReservationPaymentGateway } from './fake-reservation-payment.gateway';
import {
  createReservationPaymentGateway,
  resolvePublicApiUrl,
  resolveReservationPaymentProvider,
} from './reservation-payment.provider';
import type { ReservationPaymentGateway } from './reservation-payment-gateway';
import { MercadoPagoCheckoutGateway } from './mercado-pago-checkout.gateway';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES_ID = '0192f0a0-0000-7000-8000-00000000abcd';
const checkoutInput = {
  reservation: { id: RES_ID },
  tenantId: TENANT,
  amountArs: 9000,
  expiresAt: new Date('2026-09-27T16:10:00Z'),
  returnUrl: 'parkit://reservas',
  description: {
    parkingName: 'Playa Centro',
    entryAt: new Date('2026-09-28T12:00:00Z'),
    exitAt: new Date('2026-09-28T14:00:00Z'),
  },
};

describe('DevCheckoutGateway', () => {
  const gateway: ReservationPaymentGateway = new DevCheckoutGateway(
    'http://localhost:3000',
  );

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

  it('el reembolso de un pago devfail_ tira solo en el primer intento', async () => {
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
    // El reintento (refund:<id>:2) se recupera.
    expect(
      await gateway.refund({
        tenantId: TENANT,
        providerPaymentId: paymentId,
        amountArs: 4500,
        idempotencyKey: 'refund:x:2',
      }),
    ).toEqual({ status: 'refunded', amountArs: 4500 });
  });

  it('no busca pagos en ningún proveedor: findApprovedPayment es null', async () => {
    expect(
      await gateway.findApprovedPayment({
        tenantId: TENANT,
        reservationId: RES_ID,
      }),
    ).toBeNull();
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

  it('findApprovedPayment registra la búsqueda y responde lo configurado', async () => {
    const gateway = new FakeReservationPaymentGateway();
    const input = { tenantId: TENANT, reservationId: RES_ID };
    expect(await gateway.findApprovedPayment(input)).toBeNull();

    gateway.nextApprovedPayment = {
      providerPaymentId: 'p1',
      status: 'approved',
      amountArs: 9000,
      refundedAmountArs: 0,
      externalReference: RES_ID,
    };
    expect((await gateway.findApprovedPayment(input))?.providerPaymentId).toBe(
      'p1',
    );
    expect(gateway.findApprovedCalls).toEqual([input, input]);

    gateway.nextFindApprovedError = new Error('MP caído');
    await expect(gateway.findApprovedPayment(input)).rejects.toThrow(
      'MP caído',
    );
  });
});

describe('resolveReservationPaymentProvider', () => {
  it('por defecto: dev fuera de producción, mercado_pago en producción', () => {
    // `bun test` carga el `.env` local, que puede traer la variable: sin
    // sacarla, `undefined` cae al valor del entorno y el test depende de la
    // máquina.
    const previous = process.env.RESERVATION_PAYMENT_PROVIDER;
    try {
      delete process.env.RESERVATION_PAYMENT_PROVIDER;
      expect(resolveReservationPaymentProvider(undefined, false)).toBe('dev');
      expect(resolveReservationPaymentProvider('', false)).toBe('dev');
      expect(resolveReservationPaymentProvider(undefined, true)).toBe(
        'mercado_pago',
      );
    } finally {
      restoreEnv('RESERVATION_PAYMENT_PROVIDER', previous);
    }
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
    const previous = process.env.PUBLIC_API_URL;
    try {
      process.env.PUBLIC_API_URL = 'https://api.parkit.test';
      expect(createReservationPaymentGateway('dev')).toBeInstanceOf(
        DevCheckoutGateway,
      );
      expect(
        createReservationPaymentGateway('mercado_pago', {
          api: {} as MpApiClient,
          tokens: {} as MpTokenService,
        }),
      ).toBeInstanceOf(MercadoPagoCheckoutGateway);
    } finally {
      restoreEnv('PUBLIC_API_URL', previous);
    }
  });

  it('con mercado_pago y sin PUBLIC_API_URL el arranque falla nombrando la variable', () => {
    const previous = process.env.PUBLIC_API_URL;
    try {
      delete process.env.PUBLIC_API_URL;
      expect(() => createReservationPaymentGateway('mercado_pago')).toThrow(
        'PUBLIC_API_URL es obligatoria con RESERVATION_PAYMENT_PROVIDER=mercado_pago',
      );
      // `dev` no la necesita.
      expect(() => createReservationPaymentGateway('dev')).not.toThrow();
    } finally {
      restoreEnv('PUBLIC_API_URL', previous);
    }
  });
});

describe('resolvePublicApiUrl', () => {
  it('sin valor (o vacío) falla', () => {
    expect(() => resolvePublicApiUrl('', false)).toThrow('PUBLIC_API_URL');
    expect(() => resolvePublicApiUrl('   ', true)).toThrow('PUBLIC_API_URL');
  });

  it('saca la barra final', () => {
    expect(resolvePublicApiUrl('https://api.parkit.test/', true)).toBe(
      'https://api.parkit.test',
    );
    expect(resolvePublicApiUrl('https://api.parkit.test//', true)).toBe(
      'https://api.parkit.test',
    );
  });

  it('en producción exige HTTPS; afuera acepta http', () => {
    expect(() => resolvePublicApiUrl('http://api.parkit.test', true)).toThrow(
      'HTTPS',
    );
    expect(resolvePublicApiUrl('http://localhost:3000', false)).toBe(
      'http://localhost:3000',
    );
  });

  it('una URL inválida falla', () => {
    expect(() => resolvePublicApiUrl('no-es-una-url', false)).toThrow(
      'no es una URL válida',
    );
  });
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
