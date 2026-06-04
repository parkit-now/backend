
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {VehicleEntity} from './vehicle.entity'
import {RateEntity} from './rate.entity'
import {TenantEntity} from './tenant.entity'


export class EntryEntity {
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
rateId: string  | null;
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
vehicleId: string ;
vehicle?: VehicleEntity ;
rate?: RateEntity  | null;
tenantId: string ;
tenant?: TenantEntity ;
}
