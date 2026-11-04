
import {UserRole} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {UserTableTemplateEntity} from './user-table-template.entity'
import {UserTableTemplateMutationEntity} from './user-table-template-mutation.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'
import {AuditLogEntity} from './audit-log.entity'
import {LprDetectionEventEntity} from './lpr-detection-event.entity'
import {MpOauthStateEntity} from './mp-oauth-state.entity'
import {PaymentIntentEntity} from './payment-intent.entity'
import {ReservationEntity} from './reservation.entity'
import {DriverVehicleEntity} from './driver-vehicle.entity'
import {TenantEntity} from './tenant.entity'


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
tableTemplates?: UserTableTemplateEntity[] ;
tableTemplateMutations?: UserTableTemplateMutationEntity[] ;
applications?: OnboardingApplicationEntity[] ;
reviewedApplications?: OnboardingApplicationEntity[] ;
auditLogs?: AuditLogEntity[] ;
reviewedLprDetectionEvents?: LprDetectionEventEntity[] ;
archivedLprDetectionEvents?: LprDetectionEventEntity[] ;
mpOauthStates?: MpOauthStateEntity[] ;
createdPaymentIntents?: PaymentIntentEntity[] ;
reservations?: ReservationEntity[] ;
cancelledReservations?: ReservationEntity[] ;
driverVehicles?: DriverVehicleEntity[] ;
deletedTenants?: TenantEntity[] ;
}
