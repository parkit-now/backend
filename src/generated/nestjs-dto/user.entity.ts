
import {UserRole} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {CompanyEntity} from './company.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'
import {AuditLogEntity} from './audit-log.entity'


export class UserEntity {
  id: string ;
@ApiProperty({
  enum: UserRole,
})
role: UserRole ;
email: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
memberships?: UserMembershipEntity[] ;
ownedCompanies?: CompanyEntity[] ;
reviewedApplications?: OnboardingApplicationEntity[] ;
auditLogs?: AuditLogEntity[] ;
}
