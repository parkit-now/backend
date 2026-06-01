
import {Prisma,AuditSeverity} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class AuditLogDto {
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
}
