
import {ApiProperty} from '@nestjs/swagger'
import {CompanyEntity} from './company.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'


export class CompanyDocumentEntity {
  id: string ;
name: string ;
storagePath: string ;
mimeType: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
companyId: string ;
company?: CompanyEntity ;
applicationId: string  | null;
application?: OnboardingApplicationEntity  | null;
}
