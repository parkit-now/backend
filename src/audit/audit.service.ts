import { Injectable } from '@nestjs/common';
import type { AuditLog, AuditSeverity, Prisma, User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditEventDto } from './dto/audit-event.dto';

/**
 * Catalog of audit actions (avoids scattered magic strings).
 * Format: `<entity>.<verb>`.
 */
export const AuditActions = {
  APPLICATION_CREATED: 'application.created',
  APPLICATION_UPDATED: 'application.updated',
  APPLICATION_SUBMITTED: 'application.submitted',
  APPLICATION_DOCUMENT_ADDED: 'application.document_added',
  APPLICATION_REJECTED: 'application.rejected',
  OWNER_PROMOTED: 'user.promoted_to_owner',
  ENTITY_APPROVED: 'entity.approved',
  ENTITY_REJECTED: 'entity.rejected',
  ENTITY_PROFILE_UPDATED: 'entity.profile_updated',
  PAYMENT_METHOD_TOGGLED: 'payment_method.toggled',
  ENTRY_CORRECTED: 'entry.corrected',
  ENTRY_DELETED: 'entry.deleted',
  /** El dueño editó los precios de una tarifa y los aplicó a los autos adentro. */
  RATE_PRICES_PROPAGATED: 'rate.prices_propagated',
  ENTRY_UNDERCHARGED: 'entry.undercharged',
  // LEGACY: la caja podía desvincular la reserva de un ingreso abierto. La
  // función se eliminó; se conserva la acción para mostrar eventos históricos
  // ya guardados en `audit_log`. No se emite más.
  ENTRY_RESERVATION_UNLINKED: 'entry.reservation_unlinked',
  LPR_EVENT_REGISTERED: 'lpr_event.registered',
  LPR_EVENT_DISMISSED: 'lpr_event.dismissed',
  LPR_EVENT_SUPPRESSED: 'lpr_event.suppressed',
  LPR_EVENT_ARCHIVED: 'lpr_event.archived',
  LPR_EVENT_UNARCHIVED: 'lpr_event.unarchived',
  LPR_EVENT_IMAGE_PURGED: 'lpr_event.image_purged',
  // Admin · parkings
  PARKING_CREATED: 'parking.created',
  PARKING_UPDATED: 'parking.updated',
  PARKING_DELETED: 'parking.deleted',
  /// Se revirtió la baja antes de la purga.
  PARKING_RESTORED: 'parking.restored',
  /// Borrado definitivo: base y bucket. Esta fila queda con `tenantId = NULL`
  /// porque el tenant ya no existe, así que el nombre va en `metadata`.
  PARKING_PURGED: 'parking.purged',
  // Admin · users
  USER_ROLE_UPDATED: 'user.role_updated',
  USER_DELETED: 'user.deleted',
  MEMBERSHIP_CREATED: 'membership.created',
  MEMBERSHIP_UPDATED: 'membership.updated',
  MEMBERSHIP_DELETED: 'membership.deleted',
  // Mercado Pago · vinculación de la cuenta de cobro de una playa
  MP_ACCOUNT_LINKED: 'mp_account.linked',
  MP_ACCOUNT_UNLINKED: 'mp_account.unlinked',
  MP_ACCOUNT_LINK_FAILED: 'mp_account.link_failed',
  // ARCA · vinculación de la facturación electrónica de una playa
  ARCA_ACCOUNT_LINKED: 'arca_account.linked',
  ARCA_ACCOUNT_UNLINKED: 'arca_account.unlinked',
  // El job dejó lista la solicitud (CSR) de renovación de un certificado por
  // vencer: falta que el dueño la suba a ARCA.
  ARCA_RENEWAL_PREPARED: 'arca_account.renewal_prepared',
  // El dueño subió el certificado renovado: la cuenta ya firma con el nuevo.
  ARCA_CERTIFICATE_RENEWED: 'arca_account.certificate_renewed',
  // Venció el certificado sin renovar: la playa dejó de facturar. `warn`,
  // porque no se recupera sola.
  ARCA_CERTIFICATE_EXPIRED: 'arca_account.certificate_expired',
  // Se cobró una estadía que tenía que facturarse pero el certificado de ARCA
  // estaba vencido: la factura quedó pendiente. `warn`: es plata cobrada sin
  // comprobante, y el dueño tiene que renovar el certificado.
  INVOICE_CERT_EXPIRED: 'invoice.cert_expired',
  // Renovación exitosa del par de tokens (`MpTokenService`). Es `info`: no hay
  // nada que hacer, pero deja el rastro de cuándo rotaron los tokens, que es lo
  // primero que se mira cuando una playa deja de cobrar.
  MP_ACCOUNT_TOKEN_REFRESHED: 'mp_account.token_refreshed',
  // La cuenta se degradó a `token_expired` y se apagó el medio de pago. Es el
  // único `crit` de Mercado Pago: la playa perdió un medio de cobro y NO se
  // recupera sola, hace falta que el dueño re-vincule.
  MP_ACCOUNT_TOKEN_EXPIRED: 'mp_account.token_expired',
  // Se canceló el intento de nuestro lado pero Mercado Pago NO aceptó cancelar
  // la orden. Es `warn` y no `info` porque puede haber quedado una orden viva
  // sobre el QR de la caja: el próximo cliente que escanee el cartel impreso
  // podría llegar a pagar el monto del auto anterior. Alguien tiene que mirar
  // esto. El porqué de cancelar igual del lado nuestro está en
  // `PaymentIntentsService.cancel`.
  PAYMENT_INTENT_CANCEL_MP_FAILED: 'payment_intent.cancel_mp_failed',
  // Mercado Pago devolvió la plata de un cobro que ya estaba acreditado. Lo
  // escribe el webhook y es el único evento del que la playa pierde plata que
  // ya había dado por buena. La severidad la decide DESDE DÓNDE venía el
  // intento (ver `MpWebhookService.refund`): `crit` si ya estaba `consumed`
  // —el arqueo de ese turno contó esa plata y ahora está mal— y `warn` si
  // todavía estaba en `approved`, donde nadie lo había contado.
  PAYMENT_INTENT_REFUNDED: 'payment_intent.refunded',
  // Reservas · acciones de una persona (conductor, dueño u operador) o del
  // sistema que cambian el estado o mueven plata. `metadata.actorRole` dice
  // quién fue (owner | operator | admin | driver | system).
  RESERVATION_ACCEPTED: 'reservation.accepted',
  RESERVATION_REJECTED: 'reservation.rejected',
  RESERVATION_CANCELLED: 'reservation.cancelled',
  RESERVATION_REFUND_RETRIED: 'reservation.refund_retried',
  // El proveedor no pudo devolver la plata: `warn`, alguien tiene que
  // reintentarlo a mano.
  // El proveedor confirmó un reembolso que estaba pendiente o fallido (sistema).
  RESERVATION_REFUND_CONFIRMED: 'reservation.refund_confirmed',
  RESERVATION_REFUND_FAILED: 'reservation.refund_failed',
  // Llegó un pago que ya no correspondía (sin cupo tras vencer la retención, o
  // sobre una reserva cancelada) y el sistema lo devolvió entero.
  RESERVATION_LATE_PAYMENT_REFUNDED: 'reservation.late_payment_refunded',
} as const;

export interface RecordAuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  tenantId?: string | null;
  severity?: AuditSeverity;
  metadata?: Prisma.InputJsonValue;
}

type AuditLogWithActor = AuditLog & { actor: User | null };

/** Filters and paging accepted by `listForTenant`. */
export interface ListAuditOptions {
  severity?: AuditSeverity;
  action?: string;
  /** Inclusive lower bound on `createdAt`. */
  from?: Date;
  /** Exclusive upper bound on `createdAt`. */
  to?: Date;
  skip?: number;
  take?: number;
}

/**
 * Generic audit trail for the onboarding/configuration flow.
 *
 * Invoked explicitly from the business services (same pattern as
 * `PasswordRecoveryService.recordAudit`), not via an interceptor: the semantic
 * context (entity, metadata, severity) cannot be inferred automatically.
 *
 * Inside a transaction that already holds a Prisma `tx`, use
 * `tx.auditLog.create(...)` directly to preserve atomicity.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        actorUserId: input.actorUserId ?? null,
        tenantId: input.tenantId ?? null,
        severity: input.severity ?? 'info',
        metadata: input.metadata ?? {},
      },
    });
  }

  /**
   * A page of audit events for one entity, most recent first.
   *
   * Every filter is optional and they compose. The `createdAt` window is
   * half-open (`[from, to)`) so an event landing exactly on a boundary is
   * never counted in two adjacent ranges — the same convention the metrics
   * endpoints use.
   */
  async listForTenant(
    tenantId: string,
    opts: ListAuditOptions = {},
  ): Promise<{ items: AuditEventDto[]; total: number }> {
    const createdAt = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lt: opts.to } : {}),
    };

    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      ...(opts.severity ? { severity: opts.severity } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip ?? 0,
        take: opts.take ?? 100,
        include: { actor: true },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items: rows.map((row) => AuditService.toEvent(row)), total };
  }

  static toEvent(row: AuditLogWithActor): AuditEventDto {
    return {
      id: row.id,
      action: row.action,
      actorName: row.actor?.email ?? null,
      entityType: row.entityType,
      entityId: row.entityId,
      severity: row.severity,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
