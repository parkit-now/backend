
import {ArcaEnvironment} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ArcaAccessTicketEntity {
  certFingerprint: string ;
service: string ;
@ApiProperty({
  enum: ArcaEnvironment,
})
environment: ArcaEnvironment ;
@ApiProperty({
  description: `\'ILoginCredentials\' del SDK en JSON, cifrado con \'ARCA_KEY_ENCRYPTION_KEY\'.`,
})
credentialsEncrypted: string ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
keyVersion: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
expiresAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
