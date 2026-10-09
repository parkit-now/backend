
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class EntryDto {
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
  description: `Factura emitida fuera de Parkit; con ARCA vinculada solo el dueño puede registrarla.`,
})
manuallyInvoiced: boolean ;
manualInvoiceNumber: string  | null;
manualInvoiceType: string  | null;
manualInvoicePointOfSale: string  | null;
source: string ;
vehicleType: string  | null;
vehicleTypeId: string  | null;
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
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
deletedAt: Date  | null;
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
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
ticketNumber: number  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
prepaidAmountArs: Prisma.Decimal  | null;
}
