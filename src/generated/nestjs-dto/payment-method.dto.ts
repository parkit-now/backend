
import {PaymentMethodType,PaymentMethodInvoiceMode} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class PaymentMethodDto {
  id: string ;
@ApiProperty({
  enum: PaymentMethodType,
})
type: PaymentMethodType ;
name: string ;
enabled: boolean ;
isSystem: boolean ;
isDefault: boolean ;
@ApiProperty({
  enum: PaymentMethodInvoiceMode,
})
invoiceMode: PaymentMethodInvoiceMode ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
deletedAt: Date  | null;
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
}
