import { ApiProperty } from '@nestjs/swagger';
import type { AuditSeverity } from '@prisma/client';

/**
 * Public projection of an `audit_log` row for the portals.
 * Maps to the frontend `AuditEvent` concept (actor, action, severity, ts).
 */
export class AuditEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'Recorded action, e.g. "entity.approved"' })
  action: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Actor email (null when emitted by the system)',
  })
  actorName: string | null;

  @ApiProperty()
  entityType: string;

  @ApiProperty({ type: String, nullable: true })
  entityId: string | null;

  @ApiProperty({ enum: ['info', 'warn', 'crit'] })
  severity: AuditSeverity;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt: string;
}
