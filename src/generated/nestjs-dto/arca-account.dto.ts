
import {Prisma,ArcaAccountRole,ArcaEnvironment,ArcaAccountStatus,ArcaTaxCondition} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ArcaAccountDto {
  id: string ;
@ApiProperty({
  enum: ArcaAccountRole,
})
role: ArcaAccountRole ;
@ApiProperty({
  enum: ArcaEnvironment,
})
environment: ArcaEnvironment ;
@ApiProperty({
  enum: ArcaAccountStatus,
})
status: ArcaAccountStatus ;
cuit: string ;
iibb: string  | null;
razonSocial: string  | null;
@ApiProperty({
  enum: ArcaTaxCondition,
})
condicionIva: ArcaTaxCondition  | null;
domicilioFiscal: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
inicioActividad: Date  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
ptoVta: number  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
ivaRate: Prisma.Decimal ;
csrPem: string  | null;
certPem: string  | null;
@ApiProperty({
  description: `CIFRADA con \'ARCA_KEY_ENCRYPTION_KEY\' (AES-256-GCM). Nunca en plano.`,
})
keyEncrypted: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
keyVersion: number  | null;
@ApiProperty({
  description: `SHA-256 del certificado en hex: la clave de \'ArcaAccessTicket\'.`,
})
certFingerprint: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
certExpiresAt: Date  | null;
renewalCsrPem: string  | null;
renewalKeyEncrypted: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
renewalKeyVersion: number  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
renewalPreparedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
linkedAt: Date  | null;
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
