
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class CashSessionDto {
  id: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
openedAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
closedAt: Date  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
openingCash: Prisma.Decimal ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
leavingCash: Prisma.Decimal  | null;
notes: string  | null;
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
