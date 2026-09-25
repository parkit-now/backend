
import {ArcaEnvironment} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateArcaAccessTicketDto {
  @IsOptional()
@IsString()
certFingerprint?: string;
@IsOptional()
@IsString()
service?: string;
@ApiProperty({
  enum: ArcaEnvironment,
})
@IsOptional()
@IsIn(["homologacion","produccion"])
environment?: ArcaEnvironment;
@ApiProperty({
  description: `\'ILoginCredentials\' del SDK en JSON, cifrado con \'ARCA_KEY_ENCRYPTION_KEY\'.`,
})
@IsOptional()
@IsString()
credentialsEncrypted?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
keyVersion?: number;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
expiresAt?: Date;
}
