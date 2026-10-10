import { HttpStatus } from '@nestjs/common';
import { PaymentIntentStatus, type Tenant, type User } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { ArcaAccountsService } from '../../arca/arca-accounts.service';
import { MpAccountsService } from '../../mercado-pago/mp-accounts.service';
import { PaymentIntentsService } from '../../mercado-pago/payment-intents.service';
import { ReservationLifecycleService } from '../../reservations/reservation-lifecycle.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { ParkingDeletionService } from './parking-deletion.service';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-10-05T12:00:00.000Z');

const admin: User = {
  id: 'admin-1',
  role: 'admin',
  email: 'admin@parkit.test',
  name: 'Admin',
  createdAt: NOW,
};

function tenantRow(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT,
    name: 'Playa Centro',
    deletedAt: null,
    purgeAfter: null,
    deletedById: null,
    deletedReason: null,
    ...overrides,
  } as Tenant;
}

describe('ParkingDeletionService', () => {
  const tx = {
    tenant: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const mockPrisma = {
    tenant: { findUnique: jest.fn() },
    userMembership: { count: jest.fn() },
    entry: { count: jest.fn() },
    cashSession: { count: jest.fn() },
    invoice: { count: jest.fn() },
    lprDetectionEvent: { count: jest.fn() },
    auditLog: { count: jest.fn() },
    reservation: { count: jest.fn(), findMany: jest.fn() },
    paymentIntent: { count: jest.fn(), findMany: jest.fn() },
    mpAccount: { findUnique: jest.fn() },
    arcaAccount: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockAudit = { record: jest.fn() };
  const mockMp = { unlink: jest.fn() };
  const mockArca = { unlink: jest.fn() };
  const mockIntents = { cancel: jest.fn() };
  const mockReservations = { ownerCancel: jest.fn() };

  function makeService(): ParkingDeletionService {
    return new ParkingDeletionService(
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      mockMp as unknown as MpAccountsService,
      mockArca as unknown as ArcaAccountsService,
      mockIntents as unknown as PaymentIntentsService,
      mockReservations as unknown as ReservationLifecycleService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tenant.findUnique.mockResolvedValue(tenantRow());
    for (const counter of [
      mockPrisma.userMembership.count,
      mockPrisma.entry.count,
      mockPrisma.cashSession.count,
      mockPrisma.invoice.count,
      mockPrisma.lprDetectionEvent.count,
      mockPrisma.auditLog.count,
      mockPrisma.reservation.count,
      mockPrisma.paymentIntent.count,
    ]) {
      counter.mockResolvedValue(0);
    }
    mockPrisma.mpAccount.findUnique.mockResolvedValue(null);
    mockPrisma.arcaAccount.findFirst.mockResolvedValue(null);
    mockPrisma.reservation.findMany.mockResolvedValue([]);
    mockPrisma.paymentIntent.findMany.mockResolvedValue([]);
    tx.tenant.update.mockImplementation(({ data }: { data: Partial<Tenant> }) =>
      Promise.resolve(tenantRow(data)),
    );
    mockPrisma.$transaction.mockImplementation(
      (fn: (client: typeof tx) => unknown) => fn(tx),
    );
  });

  describe('delete', () => {
    it('rechaza un nombre que no coincide, sin tocar nada', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        makeService().delete(admin, TENANT, { confirmName: 'Playa Norte' }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: { code: ErrorCodes.PARKING_CONFIRM_NAME_MISMATCH },
      });
      expect(tx.tenant.update).not.toHaveBeenCalled();
    });

    it('acepta el nombre con otra normalización Unicode', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenantRow({ name: 'Playa Sótano' }),
      );
      await makeService().delete(admin, TENANT, {
        confirmName: 'Playa Sótano'.normalize('NFD'),
      });
      expect(tx.tenant.update).toHaveBeenCalled();
    });

    it('rechaza si ya estaba dado de baja', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenantRow({ deletedAt: NOW }),
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        makeService().delete(admin, TENANT, { confirmName: 'Playa Centro' }),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { code: ErrorCodes.PARKING_ALREADY_DELETED },
      });
    });

    it('con graceDays 0 deja la purga lista para la próxima corrida', async () => {
      // Es el camino que se usa para limpiar datos de prueba: dar de baja y
      // que el job se lo lleve esa misma noche, sin esperar 30 días.
      await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro', graceDays: 0 },
        NOW,
      );
      const { data } = tx.tenant.update.mock.calls[0][0] as {
        data: { deletedAt: Date; purgeAfter: Date };
      };
      expect(data.deletedAt).toEqual(NOW);
      expect(data.purgeAfter).toEqual(NOW);
    });

    it('sin graceDays usa la ventana de 30 días', async () => {
      await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro' },
        NOW,
      );
      const { data } = tx.tenant.update.mock.calls[0][0] as {
        data: { purgeAfter: Date };
      };
      expect(data.purgeAfter).toEqual(new Date('2026-11-04T12:00:00.000Z'));
    });

    it('audita con los números del momento del borrado', async () => {
      // Después de la purga esta fila es lo único que va a quedar.
      mockPrisma.entry.count.mockResolvedValue(314);
      mockPrisma.lprDetectionEvent.count.mockResolvedValue(151);
      await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro', reason: 'Datos de prueba' },
        NOW,
      );
      const { data } = tx.auditLog.create.mock.calls[0][0] as {
        data: {
          action: string;
          tenantId: string;
          metadata: {
            reason: string;
            snapshot: { entries: number; storageObjects: number };
          };
        };
      };
      expect(data.action).toBe('parking.deleted');
      expect(data.tenantId).toBe(TENANT);
      expect(data.metadata.reason).toBe('Datos de prueba');
      expect(data.metadata.snapshot.entries).toBe(314);
      expect(data.metadata.snapshot.storageObjects).toBe(151);
    });

    it('corre los efectos externos en orden: reservas, cobros, MP, ARCA', async () => {
      // El orden no es cosmético. Desvincular Mercado Pago primero rompe los
      // reembolsos, y además su propia guarda tira 409 si quedan reservas
      // vivas: con el orden invertido el paso ni siquiera correría.
      const order: string[] = [];
      mockPrisma.reservation.findMany.mockResolvedValue([{ id: 'r-1' }]);
      mockPrisma.paymentIntent.findMany.mockResolvedValue([{ id: 'pi-1' }]);
      mockPrisma.mpAccount.findUnique.mockResolvedValue({ id: 'mp-1' });
      mockPrisma.arcaAccount.findFirst.mockResolvedValue({ id: 'arca-1' });
      mockReservations.ownerCancel.mockImplementation(() => {
        order.push('reserva');
        return Promise.resolve();
      });
      mockIntents.cancel.mockImplementation(() => {
        order.push('cobro');
        return Promise.resolve();
      });
      mockMp.unlink.mockImplementation(() => {
        order.push('mp');
        return Promise.resolve();
      });
      mockArca.unlink.mockImplementation(() => {
        order.push('arca');
        return Promise.resolve();
      });

      const { effects } = await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro' },
        NOW,
      );

      expect(order).toEqual(['reserva', 'cobro', 'mp', 'arca']);
      expect(effects.every((e) => e.ok)).toBe(true);
    });

    it('un efecto que falla se reporta pero no deshace la baja', async () => {
      // La baja es reversible hasta la purga: abortarla por un unlink fallido
      // dejaría el estacionamiento vivo y cobrando.
      mockPrisma.mpAccount.findUnique.mockResolvedValue({ id: 'mp-1' });
      mockMp.unlink.mockRejectedValue(new Error('reservas activas'));

      const { effects } = await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro' },
        NOW,
      );

      expect(tx.tenant.update).toHaveBeenCalled();
      expect(effects).toContainEqual({
        step: 'Desvincular Mercado Pago',
        ok: false,
        detail: 'reservas activas',
      });
    });

    it('no intenta desvincular lo que no está vinculado', async () => {
      const { effects } = await makeService().delete(
        admin,
        TENANT,
        { confirmName: 'Playa Centro' },
        NOW,
      );
      expect(mockMp.unlink).not.toHaveBeenCalled();
      expect(mockArca.unlink).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
    });
  });

  describe('preflight', () => {
    it('marca la plata de terceros que quedaría colgada', async () => {
      mockPrisma.reservation.count.mockResolvedValue(2);
      mockPrisma.paymentIntent.count.mockResolvedValue(1);

      const result = await makeService().preflight(TENANT);

      expect(result.blockers).toEqual([
        '2 reembolsos pendientes',
        '1 cobro acreditado sin aplicar',
      ]);
    });

    it('sin plata colgada no marca nada', async () => {
      const result = await makeService().preflight(TENANT);
      expect(result.blockers).toEqual([]);
    });

    it('cuenta sólo las fotos que siguen en el bucket', async () => {
      await makeService().preflight(TENANT);
      expect(mockPrisma.lprDetectionEvent.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT, imageStoragePath: { not: null } },
      });
    });

    it('cuenta los cobros acreditados sin aplicar, no los abiertos', async () => {
      await makeService().preflight(TENANT);
      expect(mockPrisma.paymentIntent.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT, status: PaymentIntentStatus.approved },
      });
    });
  });

  describe('restore', () => {
    it('limpia los cuatro campos de la baja', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenantRow({
          deletedAt: NOW,
          purgeAfter: NOW,
          deletedById: 'admin-1',
          deletedReason: 'por error',
        }),
      );

      await makeService().restore(admin, TENANT);

      const { data } = tx.tenant.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toEqual({
        deletedAt: null,
        purgeAfter: null,
        deletedById: null,
        deletedReason: null,
      });
    });

    it('no revincula Mercado Pago ni ARCA', async () => {
      // Prender una credencial de cobro sin que nadie lo pida sería peor que
      // pedir que la revinculen a mano.
      mockPrisma.tenant.findUnique.mockResolvedValue(
        tenantRow({ deletedAt: NOW, purgeAfter: NOW }),
      );
      await makeService().restore(admin, TENANT);
      expect(mockMp.unlink).not.toHaveBeenCalled();
      expect(mockArca.unlink).not.toHaveBeenCalled();
    });

    it('rechaza restaurar uno que no estaba dado de baja', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(makeService().restore(admin, TENANT)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { code: ErrorCodes.PARKING_NOT_DELETED },
      });
    });
  });
});
