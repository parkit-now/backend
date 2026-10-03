
import {Prisma,ReservationStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {UserEntity} from './user.entity'
import {ReservationPaymentEntity} from './reservation-payment.entity'


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
holdExpiresAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
paidAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
approvalDeadlineAt: Date  | null;
cancelledBy: string  | null;
reason: string  | null;
refundStatus: string ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
refundedAmountArs: Prisma.Decimal  | null;
refundError: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
refundRequestedAt: Date  | null;
@ApiProperty({
  type: `number`,
  format: `double`,
})
refundRequestedArs: Prisma.Decimal  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
refundAttempts: number ;
policySnapshot: Prisma.JsonValue  | null;
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
payments?: ReservationPaymentEntity[] ;
}
