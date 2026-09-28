
import {ArcaEnvironment,ArcaTaxCondition} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateArcaAccountDto {
  @ApiProperty({
  enum: ArcaEnvironment,
})
@IsOptional()
@IsIn(["homologacion","produccion"])
environment?: ArcaEnvironment;
@IsOptional()
@IsString()
cuit?: string;
@IsOptional()
@IsString()
iibb?: string;
@IsOptional()
@IsString()
razonSocial?: string;
@ApiProperty({
  enum: ArcaTaxCondition,
})
@IsOptional()
@IsIn(["responsable_inscripto","monotributo","exento"])
condicionIva?: ArcaTaxCondition;
@IsOptional()
@IsString()
domicilioFiscal?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
inicioActividad?: Date;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
ptoVta?: number;
@IsOptional()
@IsString()
csrPem?: string;
@IsOptional()
@IsString()
certPem?: string;
@ApiProperty({
  description: `CIFRADA con \'ARCA_KEY_ENCRYPTION_KEY\' (AES-256-GCM). Nunca en plano.`,
})
@IsOptional()
@IsString()
keyEncrypted?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
keyVersion?: number;
@ApiProperty({
  description: `SHA-256 del certificado en hex: la clave de \'ArcaAccessTicket\'.`,
})
@IsOptional()
@IsString()
certFingerprint?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
certExpiresAt?: Date;
@IsOptional()
@IsString()
renewalCsrPem?: string;
@IsOptional()
@IsString()
renewalKeyEncrypted?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
renewalKeyVersion?: number;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
renewalPreparedAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
linkedAt?: Date;
}
