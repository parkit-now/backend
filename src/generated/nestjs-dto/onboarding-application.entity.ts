
import {Prisma,ApplicationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {CompanyEntity} from './company.entity'
import {UserEntity} from './user.entity'
import {CompanyDocumentEntity} from './company-document.entity'


export class OnboardingApplicationEntity {
  id: string ;
@ApiProperty({
  enum: ApplicationStatus,
})
status: ApplicationStatus ;
declaredBranches: Prisma.JsonValue ;
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
companyId: string ;
company?: CompanyEntity ;
reviewedBy: string  | null;
reviewer?: UserEntity  | null;
documents?: CompanyDocumentEntity[] ;
}
