
import {Prisma,ReservationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ReservationDto {
  id: string ;
vehiclePlate: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
entryAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
exitAt: Date ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
totalArs: Prisma.Decimal ;
rateSnapshotName: string ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotHourPriceArs: Prisma.Decimal ;
@ApiProperty({
  enum: ReservationStatus,
})
status: ReservationStatus ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
cancelledAt: Date  | null;
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
