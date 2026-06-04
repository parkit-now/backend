
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class EntryDto {
  id: string ;
plate: string ;
color: string  | null;
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
}
