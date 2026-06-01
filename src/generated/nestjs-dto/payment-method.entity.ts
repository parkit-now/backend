
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
tenantId: string ;
tenant?: TenantEntity ;
}
