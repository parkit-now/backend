
import {ApiProperty} from '@nestjs/swagger'
import {OnboardingApplicationEntity} from './onboarding-application.entity'


export class ApplicationDocumentEntity {
  id: string ;
name: string ;
storagePath: string ;
mimeType: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
applicationId: string ;
application?: OnboardingApplicationEntity ;
}
