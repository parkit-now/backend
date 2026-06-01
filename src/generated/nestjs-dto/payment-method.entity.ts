
import {PaymentMethodType} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {CompanyEntity} from './company.entity'


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
companyId: string ;
company?: CompanyEntity ;
}
