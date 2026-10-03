/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/await-thenable */
import type { User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DriverReservationsService } from '../driver/driver-reservations.service';
import type { DriverVehiclesService } from '../driver/driver-vehicles.service';
import type { DriverService } from '../driver/driver.service';
import type { CreateReservationResponseDto } from '../driver/dto/reservation.dto';
import { FakePrisma } from './fake-reservation-prisma';
import { FakeReservationPaymentGateway } from './payment-gateway/fake-reservation-payment.gateway';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

// Recorrido completo del módulo con el alta del conductor, el ciclo de vida y
// el gateway fake sobre un Prisma en memoria (sin base).

const ar = (iso: string) => new Date(`${iso}-03:00`);
const NOW = ar('2026-09-27T16:00:00');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ENTRY = ar('2026-09-28T10:00:00');
const EXIT = ar('2026-09-28T12:00:00');
const TENANT = '11111111-1111-4111-8111-111111111111';
const RES = '0192f0a0-0000-7000-8000-00000000abcd';
const USER = { id: 'user-1' } as User;

const policy = (acceptanceMode: 'auto' | 'manual') => ({
  freeCancelMinutes: 60,
  lateCancelRefundPct: 50,
  earlyArrivalMinutes: 15,
  graceMinutes: 30,
  acceptanceMode,
  approvalWindowMinutes: 15,
});

describe('reservas: recorrido completo (integración del módulo)', () => {
  let db: FakePrisma;
  let gateway: FakeReservationPaymentGateway;
  let lifecycle: ReservationLifecycleService;
  let driver: DriverReservationsService;
  let mode: 'auto' | 'manual';

  const input = {
    id: RES,
    parkingId: TENANT,
    vehiclePlate: 'AB123CD',
    entryAt: ENTRY.toISOString(),
    exitAt: EXIT.toISOString(),
    returnUrl: 'parkit://reservas',
  };

  const create = async () =>
    (await driver.create(USER, input, NOW)) as CreateReservationResponseDto;
  const view = (now: Date) => driver.get(USER, RES, now);

  beforeEach(() => {
    mode = 'manual';
    db = new FakePrisma();
    gateway = new FakeReservationPaymentGateway();
    lifecycle = new ReservationLifecycleService(
      db as unknown as PrismaService,
      gateway,
    );
    const driverService = {
      quoteForReservation: () =>
        Promise.resolve({
          quote: {
            entryAt: ENTRY.toISOString(),
            exitAt: EXIT.toISOString(),
            totalArs: 9000,
            rate: {
              name: 'RESERVAS',
              hourPriceArs: 4500,
              fractionPriceArs: 375,
              mediaEstadiaPriceArs: 27000,
              stayPriceArs: 45000,
            },
          },
          reservableSpots: 2,
          policy: policy(mode),
        }),
    };
    const vehicles = { findOwnedKind: () => Promise.resolve('car') };
    driver = new DriverReservationsService(
      db as unknown as PrismaService,
      driverService as unknown as DriverService,
      vehicles as unknown as DriverVehiclesService,
      lifecycle,
      gateway,
    );
  });

  it('modo manual: crear → pagar → pending_approval → aceptar → el conductor cancela con reembolso total', async () => {
    const created = await create();
    expect(created.reservation.status).toBe('pending_payment');
    expect(created.payment.checkoutUrl).toBe(`https://fake.checkout/${RES}`);
    expect(created.reservation.refundStatus).toBe('none');

    const paid = await lifecycle.markPaid(
      RES,
      { providerPaymentId: 'dev_1' },
      at(2),
    );
    expect(paid.outcome).toBe('pending_approval');
    expect((await view(at(2))).payment?.status).toBe('approved');

    await lifecycle.accept(TENANT, RES, at(5));
    expect((await view(at(5))).status).toBe('confirmed');

    await driver.cancel(USER, RES, at(10));
    const done = await view(at(10));
    expect(done).toMatchObject({
      status: 'cancelled',
      state: 'cancelled',
      refundStatus: 'refunded',
      refundedAmountArs: 9000,
      cancellable: false,
      payment: { status: 'refunded' },
    });
    expect(gateway.refunds).toEqual([
      expect.objectContaining({
        providerPaymentId: 'dev_1',
        amountArs: 9000,
        idempotencyKey: `refund:${RES}:1`,
      }),
    ]);
  });

  it('modo auto: crear → pagar → confirmed → el dueño cancela con reembolso total', async () => {
    mode = 'auto';
    await create();
    const paid = await lifecycle.markPaid(
      RES,
      { providerPaymentId: 'dev_2' },
      at(1),
    );
    expect(paid.outcome).toBe('confirmed');

    await lifecycle.ownerCancel(TENANT, RES, 'cierre por mantenimiento', at(3));
    expect(await view(at(3))).toMatchObject({
      status: 'cancelled',
      refundStatus: 'refunded',
      refundedAmountArs: 9000,
    });
    expect(db.reservationById()).toMatchObject({
      cancelledBy: 'owner',
      reason: 'cierre por mantenimiento',
    });
  });

  it('el dueño rechaza, el reembolso falla y el reintento lo recupera', async () => {
    await create();
    await lifecycle.markPaid(RES, { providerPaymentId: 'devfail_3' }, at(1));
    gateway.nextRefundError = new Error('devfail');

    await lifecycle.reject(TENANT, RES, 'sin lugar', at(2));
    expect(await view(at(2))).toMatchObject({
      status: 'rejected',
      refundStatus: 'failed',
    });

    gateway.nextRefundError = null;
    await lifecycle.retryRefund(TENANT, RES, at(4));
    expect(await view(at(4))).toMatchObject({
      refundStatus: 'refunded',
      refundedAmountArs: 9000,
    });
    expect(gateway.refunds.map((r) => r.idempotencyKey)).toEqual([
      `refund:${RES}:1`,
      `refund:${RES}:2`,
    ]);
  });

  it('el conductor cancela sin haber pagado y el pago llega igual: se reembolsa todo', async () => {
    await create();
    await driver.cancel(USER, RES, at(1));
    expect(await view(at(1))).toMatchObject({
      status: 'cancelled',
      refundStatus: 'none',
    });

    const late = await lifecycle.markPaid(
      RES,
      { providerPaymentId: 'dev_4' },
      at(2),
    );
    expect(late.outcome).toBe('refunded_after_cancel');
    expect(await view(at(2))).toMatchObject({
      status: 'cancelled',
      refundStatus: 'refunded',
      refundedAmountArs: 9000,
    });
  });

  it('createCheckout que falla deja la reserva expired y no cobra nada', async () => {
    gateway.nextCheckoutError = new Error('proveedor caído');
    await expect(create()).rejects.toMatchObject({ status: 503 });
    expect(db.reservationById()).toMatchObject({
      status: 'expired',
      reason: 'checkout_unavailable',
    });
    expect(db.payments).toHaveLength(0);
  });
});
