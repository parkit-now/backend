
import {PasswordResetRequestStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class PasswordResetRequestDto {
  id: string ;
email: string ;
ipAddress: string  | null;
@ApiProperty({
  enum: PasswordResetRequestStatus,
})
status: PasswordResetRequestStatus ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
requestedAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
completedAt: Date  | null;
}
