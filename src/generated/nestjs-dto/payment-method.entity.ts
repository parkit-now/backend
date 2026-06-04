
import {PaymentMethodType} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'


export class PaymentMethodEntity {
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
}
