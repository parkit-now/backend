/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/await-thenable */
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { OwnerReservationsService } from './owner-reservations.service';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES = '0192f0a0-0000-7000-8000-00000000abcd';
const ACTOR = { userId: 'user-op', role: 'operator' } as const;
const at = (iso: string) => new Date(`${iso}-03:00`);

const row = (extra: Record<string, unknown> = {}) => ({
  id: RES,
  tenantId: TENANT,
  vehiclePlate: 'AB123CD',
  entryAt: at('2026-09-28T10:00:00'),
  exitAt: at('2026-09-28T12:00:00'),
  totalArs: new Prisma.Decimal(9000),
  rateSnapshotName: 'RESERVAS',
  status: 'pending_approval',
  createdAt: at('2026-09-27T16:00:00'),
  holdExpiresAt: null,
  paidAt: at('2026-09-27T16:05:00'),
  approvalDeadlineAt: at('2026-09-27T16:20:00'),
  cancelledAt: null,
  cancelledBy: null,
  reason: null,
  refundStatus: 'none',
  refundedAmountArs: null,
  refundError: null,
  refundAttempts: 0,
  refundRequestedArs: null,
  refundRequestedAt: null,
  policySnapshot: null,
  user: { name: 'Ana Conductora' },
  payments: [
    {
      id: 'pay-1',
      status: 'approved',
      amountArs: new Prisma.Decimal(9000),
      provider: 'dev',
      providerPaymentId: 'dev_123',
      providerStatus: 'approved',
      providerStatusDetail: null,
      approvedAt: at('2026-09-27T16:05:00'),
      createdAt: at('2026-09-27T16:00:00'),
    },
  ],
  ...extra,
});

describe('OwnerReservationsService', () => {
  const tenantClient = {
    reservation: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const prisma = { getTenantClient: jest.fn(() => tenantClient) };
  const lifecycle = {
    accept: jest.fn(),
    reject: jest.fn(),
    ownerCancel: jest.fn(),
    retryRefund: jest.fn(),
  };
  const service = new OwnerReservationsService(
    prisma as unknown as PrismaService,
    lifecycle as unknown as ReservationLifecycleService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tenantClient.reservation.findFirst.mockResolvedValue(row());
    tenantClient.reservation.findMany.mockResolvedValue([row()]);
    tenantClient.reservation.count.mockResolvedValue(1);
  });

  describe('list', () => {
    it('pagina, ordena por ingreso y usa el cliente tenant', async () => {
      const result = await service.list({ page: 2, pageSize: 10 });

      const [args] = tenantClient.reservation.findMany.mock.calls[0];
      expect(args).toMatchObject({ skip: 10, take: 10, where: {} });
      expect(args.orderBy[0]).toEqual({ entryAt: 'desc' });
      expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
      expect(result.items[0]).toMatchObject({
        id: RES,
        code: 'R-00ABCD',
        status: 'pending_approval',
        driverName: 'Ana Conductora',
        totalArs: 9000,
        policy: { acceptanceMode: 'auto' },
      });
      expect(result.items[0]).not.toHaveProperty('payments');
    });

    it('filtra por estado, rango de ingreso y patente normalizada', async () => {
      await service.list({
        status: 'confirmed',
        from: '2026-09-28T00:00:00-03:00',
        to: '2026-09-29T00:00:00-03:00',
        q: ' ab-12 ',
      });
      const [args] = tenantClient.reservation.findMany.mock.calls[0];
      expect(args.where).toEqual({
        status: 'confirmed',
        entryAt: {
          gte: new Date('2026-09-28T00:00:00-03:00'),
          lte: new Date('2026-09-29T00:00:00-03:00'),
        },
        vehiclePlate: { contains: 'AB12' },
      });
      expect(tenantClient.reservation.count).toHaveBeenCalledWith({
        where: args.where,
      });
    });
  });

  describe('get', () => {
    it('devuelve el detalle con los pagos y el providerPaymentId', async () => {
      const result = await service.get(TENANT, RES);
      expect(result.payments).toEqual([
        expect.objectContaining({
          status: 'approved',
          amountArs: 9000,
          providerPaymentId: 'dev_123',
        }),
      ]);
      expect(result.refundAttempts).toBe(0);
    });

    it('una reserva de otra playa (el cliente tenant no la ve) responde 404', async () => {
      tenantClient.reservation.findFirst.mockResolvedValue(null);
      const failed = service.get(TENANT, RES);
      await expect(failed).rejects.toBeInstanceOf(FormattedException);
      await expect(failed).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('acciones', () => {
    it('accept, reject, cancel y retryRefund pasan el tenant de la ruta al ciclo de vida y devuelven el detalle', async () => {
      await service.accept(TENANT, RES, ACTOR);
      await service.reject(TENANT, RES, 'sin lugar', ACTOR);
      await service.cancel(TENANT, RES, 'cierre', ACTOR);
      const result = await service.retryRefund(TENANT, RES, ACTOR);

      expect(lifecycle.accept).toHaveBeenCalledWith(TENANT, RES, ACTOR);
      expect(lifecycle.reject).toHaveBeenCalledWith(
        TENANT,
        RES,
        'sin lugar',
        ACTOR,
      );
      expect(lifecycle.ownerCancel).toHaveBeenCalledWith(
        TENANT,
        RES,
        'cierre',
        ACTOR,
      );
      expect(lifecycle.retryRefund).toHaveBeenCalledWith(TENANT, RES, ACTOR);
      expect(result.id).toBe(RES);
    });

    it('si el ciclo de vida responde 409 no relee nada', async () => {
      lifecycle.accept.mockRejectedValue(new Error('409'));
      await expect(service.accept(TENANT, RES, ACTOR)).rejects.toThrow('409');
      expect(tenantClient.reservation.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('match (banner de la caja)', () => {
    const now = at('2026-09-28T09:52:00');
    const confirmed = row({
      status: 'confirmed',
      vehicleCategory: 'car',
      policySnapshot: { earlyArrivalMinutes: 15, graceMinutes: 30 },
    });

    it('devuelve la reserva confirmada dentro de la ventana con el prepago y la franja', async () => {
      tenantClient.reservation.findMany.mockResolvedValue([confirmed]);

      const { reservation } = await service.match(TENANT, 'ab 123 cd', now);

      const args = tenantClient.reservation.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        tenantId: TENANT,
        vehiclePlate: 'AB123CD',
        status: { in: ['confirmed', 'no_show'] },
      });
      expect(reservation).toMatchObject({
        id: RES,
        code: 'R-00ABCD',
        status: 'confirmed',
        vehiclePlate: 'AB123CD',
        vehicleCategory: 'car',
        driverName: 'Ana Conductora',
        totalArs: 9000,
        prepaidAmountArs: 9000,
        arrivalFrom: at('2026-09-28T09:45:00').toISOString(),
        arrivalUntil: at('2026-09-28T10:30:00').toISOString(),
      });
    });

    it('antes de la llegada anticipada no hay banner', async () => {
      tenantClient.reservation.findMany.mockResolvedValue([confirmed]);
      const { reservation } = await service.match(
        TENANT,
        'AB123CD',
        at('2026-09-28T09:40:00'),
      );
      expect(reservation).toBeNull();
    });

    it('una patente vacía no consulta la base', async () => {
      const { reservation } = await service.match(TENANT, '--', now);
      expect(reservation).toBeNull();
      expect(tenantClient.reservation.findMany).not.toHaveBeenCalled();
    });
  });

  it('el listado incluye el ingreso vinculado (stay) con el excedente cobrado', async () => {
    tenantClient.reservation.findMany.mockResolvedValue([
      row({
        status: 'completed',
        entry: {
          id: 'entry-1',
          enteredAt: at('2026-09-28T09:52:00'),
          leftAt: at('2026-09-28T12:40:00'),
          amountPaid: new Prisma.Decimal(1000),
          prepaidAmountArs: new Prisma.Decimal(9000),
        },
      }),
    ]);

    const page = await service.list({});

    expect(page.items[0].stay).toEqual({
      entryId: 'entry-1',
      enteredAt: at('2026-09-28T09:52:00').toISOString(),
      leftAt: at('2026-09-28T12:40:00').toISOString(),
      excessChargedArs: 1000,
      prepaidAmountArs: 9000,
    });
  });
});
