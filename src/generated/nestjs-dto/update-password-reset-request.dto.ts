
import {PasswordResetRequestStatus} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePasswordResetRequestDto {
  @IsOptional()
@IsString()
email?: string;
@IsOptional()
@IsString()
ipAddress?: string;
@ApiProperty({
  enum: PasswordResetRequestStatus,
})
@IsOptional()
@IsIn(["sent","email_failed","ignored_unknown_email","ignored_rate_limited","completed"])
status?: PasswordResetRequestStatus;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
completedAt?: Date;
}
