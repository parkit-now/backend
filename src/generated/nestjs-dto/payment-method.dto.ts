
import {PaymentMethodType} from '@prisma/client'
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
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
