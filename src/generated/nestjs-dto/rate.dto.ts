
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class RateDto {
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
}
