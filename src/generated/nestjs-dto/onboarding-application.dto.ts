
import {Prisma,ApplicationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class OnboardingApplicationDto {
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
}
