
import {Prisma,BranchStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {EntryEntity} from './entry.entity'
import {RateEntity} from './rate.entity'
import {ScheduleEntity} from './schedule.entity'
import {ServiceEntity} from './service.entity'
import {PaymentMethodEntity} from './payment-method.entity'
import {AuditLogEntity} from './audit-log.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'


export class TenantEntity {
  id: string ;
name: string ;
legalName: string  | null;
cuit: string  | null;
email: string  | null;
phone: string  | null;
address: string  | null;
@ApiProperty({
  enum: BranchStatus,
})
status: BranchStatus ;
settings: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
memberships?: UserMembershipEntity[] ;
entries?: EntryEntity[] ;
rates?: RateEntity[] ;
schedules?: ScheduleEntity[] ;
services?: ServiceEntity[] ;
paymentMethods?: PaymentMethodEntity[] ;
auditLogs?: AuditLogEntity[] ;
applications?: OnboardingApplicationEntity[] ;
}
