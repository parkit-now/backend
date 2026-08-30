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
      createdAt: row.createdAt.toISOString(),
    };
  }
}
