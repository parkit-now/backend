
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {WhitelistEntity} from './whitelist.entity'
import {RateEntity} from './rate.entity'
import {CashSessionEntity} from './cash-session.entity'
import {PaymentTransactionEntity} from './payment-transaction.entity'
import {InvoiceEntity} from './invoice.entity'
import {LprDetectionEventEntity} from './lpr-detection-event.entity'
import {PaymentIntentEntity} from './payment-intent.entity'
import {TenantEntity} from './tenant.entity'


export class EntryEntity {
  id: string ;
plate: string ;
color: string  | null;
cochera: string  | null;
notes: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
enteredAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
leftAt: Date  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
amountPaid: Prisma.Decimal  | null;
@ApiProperty({
  description: `Checkbox "Facturada" para las playas sin integración con ARCA.`,
})
manuallyInvoiced: boolean ;
source: string ;
vehicleType: string  | null;
entryImageUrl: string  | null;
entryCameraId: string  | null;
exitImageUrl: string  | null;
exitCameraId: string  | null;
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
rateId: string  | null;
rateSnapshotName: string  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotHourPriceArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotStayPriceArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotFractionPriceArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotMediaEstadiaPriceArs: Prisma.Decimal  | null;
vehicleBrand: string  | null;
vehicleModel: string  | null;
cashSessionId: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
ticketNumber: number  | null;
whitelistId: string  | null;
whitelist?: WhitelistEntity  | null;
rate?: RateEntity  | null;
cashSession?: CashSessionEntity  | null;
paymentTransactions?: PaymentTransactionEntity[] ;
invoice?: InvoiceEntity  | null;
lprDetectionEvents?: LprDetectionEventEntity[] ;
paymentIntents?: PaymentIntentEntity[] ;
tenantId: string ;
tenant?: TenantEntity ;
}
