
import {CompanyStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'
import {TenantEntity} from './tenant.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'
import {CompanyDocumentEntity} from './company-document.entity'
import {PaymentMethodEntity} from './payment-method.entity'
import {AuditLogEntity} from './audit-log.entity'


export class CompanyEntity {
  id: string ;
legalName: string ;
cuit: string ;
email: string ;
phone: string  | null;
address: string  | null;
@ApiProperty({
  enum: CompanyStatus,
})
status: CompanyStatus ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
ownerUserId: string ;
owner?: UserEntity ;
tenants?: TenantEntity[] ;
applications?: OnboardingApplicationEntity[] ;
documents?: CompanyDocumentEntity[] ;
paymentMethods?: PaymentMethodEntity[] ;
auditLogs?: AuditLogEntity[] ;
}
