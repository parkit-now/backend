
import {ArcaEnvironment} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsNotEmpty,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateArcaAccessTicketDto {
  @IsNotEmpty()
@IsString()
certFingerprint: string;
@IsNotEmpty()
@IsString()
service: string;
@ApiProperty({
  enum: ArcaEnvironment,
})
@IsNotEmpty()
@IsIn(["homologacion","produccion"])
environment: ArcaEnvironment;
@ApiProperty({
  description: `\'ILoginCredentials\' del SDK en JSON, cifrado con \'ARCA_KEY_ENCRYPTION_KEY\'.`,
})
@IsNotEmpty()
@IsString()
credentialsEncrypted: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsNotEmpty()
@IsInt()
keyVersion: number;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
expiresAt: Date;
}
