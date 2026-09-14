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
  ENTRY_UNDERCHARGED: 'entry.undercharged',
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

  async listForTenant(
    tenantId: string,
    opts?: { limit?: number; severity?: AuditSeverity },
  ): Promise<AuditEventDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(opts?.severity ? { severity: opts.severity } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 100,
      include: { actor: true },
    });
    return rows.map((row) => AuditService.toEvent(row));
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
