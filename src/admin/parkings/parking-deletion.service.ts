import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  PaymentIntentStatus,
  ReservationStatus,
  type Prisma,
  type Tenant,
  type User,
} from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { ArcaAccountsService } from '../../arca/arca-accounts.service';
import { MpAccountsService } from '../../mercado-pago/mp-accounts.service';
import { PaymentIntentsService } from '../../mercado-pago/payment-intents.service';
import {
  ReservationLifecycleService,
  type ReservationActor,
} from '../../reservations/reservation-lifecycle.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { DeleteParkingDto, DEFAULT_GRACE_DAYS } from './dto/delete-parking.dto';
import { DeletionPreflightDto } from './dto/deletion-preflight.dto';
import { DeletionEffectDto } from './dto/deletion-result.dto';
import { parkingNameMatches } from './parking-name-match';

const INSTANCE = '/admin/parkings';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Las reservas que todavía esperan algo: un ingreso, un pago o un reembolso.
 *
 * Es EL MISMO conjunto que mira `MpAccountsService.assertNoActiveReservations`,
 * y tiene que seguir siéndolo: esa guarda es la que decide si se puede
 * desvincular Mercado Pago, así que cancelar exactamente estas es lo que hace
 * que el paso siguiente del borrado pueda pasar. Si divergen, la baja va a
 * cancelar reservas y aun así no va a poder desvincular.
 */
function liveReservationsWhere(
  tenantId: string,
  now: Date,
): Prisma.ReservationWhereInput {
  return {
    tenantId,
    OR: [
      {
        status: {
          in: [ReservationStatus.confirmed, ReservationStatus.pending_approval],
        },
        entryAt: { gt: now },
      },
      {
        status: ReservationStatus.pending_payment,
        holdExpiresAt: { gt: now },
      },
      { refundStatus: 'pending' },
    ],
  };
}

/**
 * Baja lógica de un estacionamiento, con ventana de gracia y restauración.
 *
 * POR QUÉ NO ESTÁ EN `ParkingsService`
 *
 * Esto necesita Mercado Pago, ARCA y el ciclo de vida de reservas. Meterlo
 * en el CRUD del inventario le colgaría esas tres dependencias a un servicio
 * que hoy sólo habla con Prisma y la auditoría.
 */
@Injectable()
export class ParkingDeletionService {
  private readonly logger = new Logger(ParkingDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mpAccounts: MpAccountsService,
    private readonly arcaAccounts: ArcaAccountsService,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly reservations: ReservationLifecycleService,
  ) {}

  /** Los números de lo que se va a destruir, para mostrarlos antes de confirmar. */
  async preflight(id: string): Promise<DeletionPreflightDto> {
    const tenant = await this.requireTenant(id);

    const [
      staff,
      carsInside,
      entries,
      openCashSessions,
      cashSessions,
      invoices,
      storageObjects,
      auditRows,
      reservations,
      pendingRefunds,
      approvedIntents,
      mpAccount,
      arcaAccount,
    ] = await Promise.all([
      this.prisma.userMembership.count({ where: { tenantId: id } }),
      this.prisma.entry.count({
        where: { tenantId: id, leftAt: null, deletedAt: null },
      }),
      this.prisma.entry.count({ where: { tenantId: id } }),
      this.prisma.cashSession.count({
        where: { tenantId: id, closedAt: null },
      }),
      this.prisma.cashSession.count({ where: { tenantId: id } }),
      this.prisma.invoice.count({ where: { tenantId: id } }),
      this.prisma.lprDetectionEvent.count({
        where: { tenantId: id, imageStoragePath: { not: null } },
      }),
      this.prisma.auditLog.count({ where: { tenantId: id } }),
      this.prisma.reservation.count({ where: { tenantId: id } }),
      this.prisma.reservation.count({
        where: { tenantId: id, refundStatus: 'pending' },
      }),
      this.prisma.paymentIntent.count({
        where: { tenantId: id, status: PaymentIntentStatus.approved },
      }),
      this.prisma.mpAccount.findUnique({ where: { tenantId: id } }),
      this.prisma.arcaAccount.findUnique({ where: { tenantId: id } }),
    ]);

    // Sólo plata de terceros que quedaría colgada. Un turno de caja abierto o
    // autos adentro son problemas del dueño y se muestran como números; esto
    // es dinero que alguien ya pagó y nadie le devolvió.
    const blockers: string[] = [];
    if (pendingRefunds > 0) {
      blockers.push(
        `${pendingRefunds} reembolso${pendingRefunds === 1 ? '' : 's'} pendiente${pendingRefunds === 1 ? '' : 's'}`,
      );
    }
    if (approvedIntents > 0) {
      blockers.push(
        `${approvedIntents} cobro${approvedIntents === 1 ? '' : 's'} acreditado${approvedIntents === 1 ? '' : 's'} sin aplicar`,
      );
    }

    return {
      tenantId: tenant.id,
      name: tenant.name,
      staff,
      carsInside,
      entries,
      openCashSessions,
      cashSessions,
      invoices,
      storageObjects,
      auditRows,
      reservations,
      mercadoPagoLinked: mpAccount !== null,
      arcaLinked: arcaAccount !== null,
      blockers,
    };
  }

  /**
   * Da de baja. NO borra: marca, y la purga termina el trabajo pasado el plazo.
   *
   * El orden —marcar primero, limpiar después— es deliberado. La marca es lo
   * que corta la entrada de plata nueva: a partir de ahí el conductor no
   * encuentra la playa y el operador recibe 410. Si se limpiara primero,
   * durante el barrido de reservas podrían seguir entrando nuevas.
   */
  async delete(
    admin: User,
    id: string,
    dto: DeleteParkingDto,
    now = new Date(),
  ): Promise<{ tenant: Tenant; effects: DeletionEffectDto[] }> {
    const tenant = await this.requireTenant(id);

    if (tenant.deletedAt) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Parking ${id} is already deleted`,
        `${INSTANCE}/${id}/deletion`,
        ErrorCodes.PARKING_ALREADY_DELETED,
      );
    }

    if (!parkingNameMatches(dto.confirmName, tenant.name)) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'The typed name does not match this parking lot',
        `${INSTANCE}/${id}/deletion`,
        ErrorCodes.PARKING_CONFIRM_NAME_MISMATCH,
      );
    }

    const graceDays = dto.graceDays ?? DEFAULT_GRACE_DAYS;
    const snapshot = await this.preflight(id);

    // Marca y auditoría juntas. El borrado viejo insertaba la auditoría DESPUÉS
    // del DELETE, así que un fallo dejaba el estacionamiento borrado y sin
    // registro de quién lo borró.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.tenant.update({
        where: { id },
        data: {
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + graceDays * DAY_MS),
          deletedById: admin.id,
          deletedReason: dto.reason ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          action: AuditActions.PARKING_DELETED,
          entityType: 'tenant',
          entityId: id,
          actorUserId: admin.id,
          // El tenant todavía existe, así que la fila puede referenciarlo. La
          // purga la va a borrar junto con el resto.
          tenantId: id,
          severity: 'warn',
          metadata: {
            name: tenant.name,
            graceDays,
            purgeAfter: row.purgeAfter?.toISOString() ?? null,
            reason: dto.reason ?? null,
            // Los números del momento del borrado: después de la purga es lo
            // único que va a quedar de este estacionamiento.
            snapshot: { ...snapshot },
          },
        },
      });

      return row;
    });

    const effects = await this.runExternalEffects(admin, id, now);

    return { tenant: updated, effects };
  }

  /**
   * Los efectos externos, EN ORDEN. El orden es la parte que importa:
   *
   *   1. Cancelar las reservas vivas, reembolsando lo que corresponda.
   *   2. Cancelar los cobros con QR que están esperando a alguien.
   *   3. Desvincular Mercado Pago.
   *   4. Desvincular ARCA.
   *
   * Mercado Pago va DESPUÉS de los reembolsos por dos motivos que apuntan al
   * mismo lado. Uno de producto: desvinculado ya no se puede reembolsar, así
   * que invertir el orden deja a conductores que pagaron sin forma de cobrar.
   * Uno mecánico: `MpAccountsService.unlink()` tiene su propia guarda que tira
   * 409 si quedan reservas vivas, o sea que con el orden invertido ni siquiera
   * correría.
   *
   * Ninguno es fatal. La baja ya está hecha y es reversible hasta la purga; un
   * fallo acá se reporta para que alguien lo mire, no deshace nada.
   */
  private async runExternalEffects(
    admin: User,
    tenantId: string,
    now: Date,
  ): Promise<DeletionEffectDto[]> {
    const effects: DeletionEffectDto[] = [];

    const record = async (step: string, run: () => Promise<void>) => {
      try {
        await run();
        effects.push({ step, ok: true, detail: null });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Deletion effect failed for tenant ${tenantId}: ${step}`,
          error instanceof Error ? error.stack : error,
        );
        effects.push({ step, ok: false, detail });
      }
    };

    const live = await this.prisma.reservation.findMany({
      where: liveReservationsWhere(tenantId, now),
      select: { id: true },
    });
    const actor: ReservationActor = { userId: admin.id, role: 'admin' };
    for (const { id } of live) {
      await record(`Cancelar la reserva ${id}`, async () => {
        await this.reservations.ownerCancel(
          tenantId,
          id,
          'El estacionamiento fue dado de baja.',
          actor,
        );
      });
    }

    const openIntents = await this.prisma.paymentIntent.findMany({
      where: {
        tenantId,
        status: {
          in: [PaymentIntentStatus.created, PaymentIntentStatus.pending],
        },
      },
      select: { id: true },
    });
    for (const { id } of openIntents) {
      await record(`Cancelar el cobro ${id}`, async () => {
        await this.paymentIntents.cancel(tenantId, id, admin);
      });
    }

    const mpAccount = await this.prisma.mpAccount.findUnique({
      where: { tenantId },
    });
    if (mpAccount) {
      await record('Desvincular Mercado Pago', async () => {
        await this.mpAccounts.unlink(tenantId, admin);
      });
    }

    const arcaAccount = await this.prisma.arcaAccount.findUnique({
      where: { tenantId },
    });
    if (arcaAccount) {
      await record('Desvincular ARCA', async () => {
        await this.arcaAccounts.unlink(tenantId, admin);
      });
    }

    return effects;
  }

  /** Revierte la baja. Sólo sirve antes de la purga: después no queda nada. */
  async restore(admin: User, id: string): Promise<Tenant> {
    const tenant = await this.requireTenant(id);

    if (!tenant.deletedAt) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Parking ${id} is not deleted`,
        `${INSTANCE}/${id}/restore`,
        ErrorCodes.PARKING_NOT_DELETED,
      );
    }

    // Capturado afuera del closure: TypeScript pierde el estrechamiento del
    // `if` de arriba al cruzar la frontera de la callback.
    const deletedAt = tenant.deletedAt;

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.tenant.update({
        where: { id },
        data: {
          deletedAt: null,
          purgeAfter: null,
          deletedById: null,
          deletedReason: null,
        },
      });

      await tx.auditLog.create({
        data: {
          action: AuditActions.PARKING_RESTORED,
          entityType: 'tenant',
          entityId: id,
          actorUserId: admin.id,
          tenantId: id,
          severity: 'warn',
          metadata: {
            name: tenant.name,
            // Lo que se deshizo: útil para entender por qué volvió.
            deletedAt: deletedAt.toISOString(),
            reason: tenant.deletedReason,
          },
        },
      });

      // Lo que la baja apagó NO se vuelve a prender solo: Mercado Pago y ARCA
      // se revinculan a mano, y las reservas canceladas quedan canceladas.
      // Restaurar devuelve el estacionamiento y sus datos, no el estado de sus
      // integraciones — prender una credencial de cobro sin que nadie lo pida
      // sería peor que pedir que la revinculen.
      return row;
    });
  }

  private async requireTenant(id: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Parking ${id} not found`,
        INSTANCE,
        ErrorCodes.PARKING_NOT_FOUND,
      );
    }
    return tenant;
  }
}
