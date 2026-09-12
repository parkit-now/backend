
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {EntryEntity} from './entry.entity'
import {TenantEntity} from './tenant.entity'


export class RateEntity {
  id: string ;
name: string ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
hourPriceArs: Prisma.Decimal ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
stayPriceArs: Prisma.Decimal ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
fractionPriceArs: Prisma.Decimal ;
isActive: boolean ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
shortcutNumber: number  | null;
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
createdAt: Date ;
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
entries?: EntryEntity[] ;
tenantId: string ;
tenant?: TenantEntity ;
}
