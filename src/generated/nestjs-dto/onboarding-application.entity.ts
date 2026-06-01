
import {Prisma,ApplicationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'
import {TenantEntity} from './tenant.entity'
import {ApplicationDocumentEntity} from './application-document.entity'


export class OnboardingApplicationEntity {
  id: string ;
@ApiProperty({
  enum: ApplicationStatus,
})
status: ApplicationStatus ;
declaredEntity: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
submittedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
reviewedAt: Date  | null;
rejectionReason: string  | null;
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
applicantUserId: string ;
applicant?: UserEntity ;
reviewedBy: string  | null;
reviewer?: UserEntity  | null;
tenantId: string  | null;
tenant?: TenantEntity  | null;
documents?: ApplicationDocumentEntity[] ;
}
