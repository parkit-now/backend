
import {Prisma,AuditSeverity} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'
import {TenantEntity} from './tenant.entity'


export class AuditLogEntity {
  id: string ;
action: string ;
entityType: string ;
entityId: string  | null;
@ApiProperty({
  enum: AuditSeverity,
})
severity: AuditSeverity ;
metadata: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
actorUserId: string  | null;
actor?: UserEntity  | null;
tenantId: string  | null;
tenant?: TenantEntity  | null;
}
