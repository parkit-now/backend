import { Injectable } from '@nestjs/common';
import type { AuditLog, AuditSeverity, Prisma, User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditEventDto } from './dto/audit-event.dto';

/**
 * Catalog of audit actions (avoids scattered magic strings).
 * Format: `<entity>.<verb>`.
 */
export const AuditActions = {
  COMPANY_CREATED: 'company.created',
  OWNER_PROMOTED: 'user.promoted_to_owner',
  COMPANY_PROFILE_UPDATED: 'company.profile_updated',
  COMPANY_APPROVED: 'company.approved',
  COMPANY_SUSPENDED: 'company.suspended',
  APPLICATION_SUBMITTED: 'application.submitted',
  APPLICATION_UPDATED: 'application.updated',
  APPLICATION_REJECTED: 'application.rejected',
  APPLICATION_ACTIVE_TENANT_FAILED: 'application.active_tenant_failed',
  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  PAYMENT_METHOD_TOGGLED: 'payment_method.toggled',
} as const;

export interface RecordAuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  companyId?: string | null;
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
        companyId: input.companyId ?? null,
        severity: input.severity ?? 'info',
        metadata: input.metadata ?? {},
      },
    });
  }

  async listForCompany(
    companyId: string,
    opts?: { limit?: number; severity?: AuditSeverity },
  ): Promise<AuditEventDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        companyId,
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
      createdAt: row.createdAt.toISOString(),
    };
  }
}
