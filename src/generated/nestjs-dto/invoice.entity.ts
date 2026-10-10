
import {Prisma,InvoiceStatus,ArcaEnvironment,ArcaTaxCondition} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {EntryEntity} from './entry.entity'
import {ArcaAccountEntity} from './arca-account.entity'
import {TenantEntity} from './tenant.entity'
import {ArcaRequestEntity} from './arca-request.entity'


export class InvoiceEntity {
  id: string ;
@ApiProperty({
  description: `UNIQUE: nunca dos facturas para la misma estadía.`,
})
entryId: string ;
entry?: EntryEntity ;
arcaAccountId: string  | null;
arcaAccount?: ArcaAccountEntity  | null;
@ApiProperty({
  enum: InvoiceStatus,
})
status: InvoiceStatus ;
errorCode: string  | null;
errorMessage: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
attempts: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
issuingStartedAt: Date  | null;
@ApiProperty({
  enum: ArcaEnvironment,
})
environment: ArcaEnvironment  | null;
emisorCuit: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
cbteTipo: number  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
ptoVta: number  | null;
@ApiProperty({
  description: `Se guarda ANTES de llamar a ARCA para poder reconciliar si la llamada se
corta. Si ARCA rechaza, vuelve a null.`,
  type: `integer`,
  format: `int32`,
})
cbteNro: number  | null;
cae: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
caeVto: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
cbteFch: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
fchServDesde: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
fchServHasta: Date  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
receptorDocTipo: number  | null;
receptorDocNro: string  | null;
receptorNombre: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
receptorCondicionIvaId: number  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
impTotal: Prisma.Decimal ;
selectedPaymentIds: string[] ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
impNeto: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
impIva: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
ivaRate: Prisma.Decimal  | null;
emisorRazonSocial: string  | null;
emisorDomicilio: string  | null;
@ApiProperty({
  enum: ArcaTaxCondition,
})
emisorCondicionIva: ArcaTaxCondition  | null;
emisorIibb: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
emisorInicioActividad: Date  | null;
issuedByUserId: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
issuedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
version: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
syncSeq: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
tenantId: string ;
tenant?: TenantEntity ;
arcaRequests?: ArcaRequestEntity[] ;
}
