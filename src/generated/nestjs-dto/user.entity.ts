
import {UserRole} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'
import {AuditLogEntity} from './audit-log.entity'
import {LprDetectionEventEntity} from './lpr-detection-event.entity'


export class UserEntity {
  id: string ;
@ApiProperty({
  enum: UserRole,
})
role: UserRole ;
email: string ;
name: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
memberships?: UserMembershipEntity[] ;
applications?: OnboardingApplicationEntity[] ;
reviewedApplications?: OnboardingApplicationEntity[] ;
auditLogs?: AuditLogEntity[] ;
reviewedLprDetectionEvents?: LprDetectionEventEntity[] ;
archivedLprDetectionEvents?: LprDetectionEventEntity[] ;
}
