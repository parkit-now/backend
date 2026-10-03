
import {Prisma,ReservationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {UserEntity} from './user.entity'


export class ReservationEntity {
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
  type: `number`,
  format: `double`,
})
rateSnapshotFractionPriceArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotMediaEstadiaPriceArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
rateSnapshotStayPriceArs: Prisma.Decimal  | null;
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
tenantId: string ;
tenant?: TenantEntity ;
userId: string ;
user?: UserEntity ;
}
