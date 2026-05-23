
import {PasswordResetRequestStatus} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreatePasswordResetRequestDto {
  @IsNotEmpty()
@IsString()
email: string;
@IsOptional()
@IsString()
ipAddress?: string;
@ApiProperty({
  enum: PasswordResetRequestStatus,
})
@IsNotEmpty()
@IsIn(["sent","email_failed","ignored_unknown_email","ignored_rate_limited","completed"])
status: PasswordResetRequestStatus;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
completedAt?: Date;
}
