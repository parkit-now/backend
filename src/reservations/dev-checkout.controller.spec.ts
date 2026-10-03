/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/await-thenable */
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { PrismaService } from '../database/prisma.service';
import { DevCheckoutController } from './dev-checkout.controller';
import { DevCheckoutGateway } from './payment-gateway/dev-checkout.gateway';
import { FakeReservationPaymentGateway } from './payment-gateway/fake-reservation-payment.gateway';
import type { ReservationLifecycleService } from './reservation-lifecycle.service';
import { ReservationsModule } from './reservations.module';

const RES = '0192f0a0-0000-7000-8000-00000000abcd';

function fakeResponse() {
  const res: Record<string, ReturnType<typeof jest.fn>> = {};
  res.status = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  return res;
}

describe('DevCheckoutController', () => {
  const prisma = {
    reservation: { findUnique: jest.fn() },
    reservationPayment: { findFirst: jest.fn() },
  };
  const lifecycle = {
    markPaid: jest.fn(),
    markPaymentRejected: jest.fn(),
  };
  const build = (gateway = new DevCheckoutGateway('http://localhost:3000')) =>
    new DevCheckoutController(
      prisma as unknown as PrismaService,
      lifecycle as unknown as ReservationLifecycleService,
      gateway,
    );
  const original = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    prisma.reservation.findUnique.mockResolvedValue({
      id: RES,
      vehiclePlate: 'AB123CD',
      entryAt: new Date('2026-09-28T13:00:00Z'),
      exitAt: new Date('2026-09-28T15:00:00Z'),
      totalArs: new Prisma.Decimal(9000),
      status: 'pending_payment',
      tenant: { name: 'Playa <Once>' },
    });
    prisma.reservationPayment.findFirst.mockResolvedValue({
      returnUrl: 'parkit://reservas?x=1',
    });
    lifecycle.markPaid.mockResolvedValue({ outcome: 'confirmed' });
  });
  afterAll(() => {
    process.env.NODE_ENV = original;
  });

  it('GET muestra monto, playa y los botones, escapando el HTML', async () => {
    const res = fakeResponse();
    await build().checkout(RES, res as unknown as Response);
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Aprobar');
    expect(html).toContain('Rechazar');
    expect(html).toContain('failRefund');
    expect(html).toContain('9.000');
    expect(html).toContain('Playa &lt;Once&gt;');
    expect(html).not.toContain('<Once>');
  });

  it('GET de una reserva inexistente responde 404', async () => {
    prisma.reservation.findUnique.mockResolvedValue(null);
    await expect(
      build().checkout(RES, fakeResponse() as unknown as Response),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('aprobar paga con un id dev_ y redirige al returnUrl con el resultado', async () => {
    const res = fakeResponse();
    await build().approve(RES, {}, res as unknown as Response);
    expect(lifecycle.markPaid).toHaveBeenCalledWith(RES, {
      providerPaymentId: expect.stringMatching(/^dev_/) as unknown,
    });
    const [status, url] = res.redirect.mock.calls[0] as [number, string];
    expect(status).toBe(302);
    expect(url).toContain('parkit://reservas');
    expect(url).toContain(`reservationId=${RES}`);
    expect(url).toContain('status=approved');
    expect(url).toContain('x=1');
  });

  it('con la casilla tildada el id de pago es devfail_', async () => {
    await build().approve(
      RES,
      { failRefund: 'on' },
      fakeResponse() as unknown as Response,
    );
    expect(lifecycle.markPaid).toHaveBeenCalledWith(RES, {
      providerPaymentId: expect.stringMatching(/^devfail_/) as unknown,
    });
  });

  it('rechazar marca el pago rechazado y redirige con status=rejected', async () => {
    const res = fakeResponse();
    await build().reject(RES, res as unknown as Response);
    expect(lifecycle.markPaymentRejected).toHaveBeenCalledWith(RES);
    expect(res.redirect.mock.calls[0][1]).toContain('status=rejected');
  });

  it('sin returnUrl responde una página de listo', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue({ returnUrl: null });
    const res = fakeResponse();
    await build().approve(RES, {}, res as unknown as Response);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.send.mock.calls[0][0]).toContain('Listo');
  });

  it('con otro gateway o en producción responde 404 y no toca nada', async () => {
    await expect(
      build(new FakeReservationPaymentGateway() as never).approve(
        RES,
        {},
        fakeResponse() as unknown as Response,
      ),
    ).rejects.toMatchObject({ status: 404 });

    process.env.NODE_ENV = 'production';
    await expect(
      build().checkout(RES, fakeResponse() as unknown as Response),
    ).rejects.toMatchObject({ status: 404 });
    expect(lifecycle.markPaid).not.toHaveBeenCalled();
    expect(prisma.reservation.findUnique).not.toHaveBeenCalled();
  });

  it('el módulo lo registra sólo con el proveedor dev', () => {
    const controllers = Reflect.getMetadata('controllers', ReservationsModule);
    expect(controllers).toContain(DevCheckoutController);
  });
});
