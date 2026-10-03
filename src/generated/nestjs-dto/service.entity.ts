
import {ServiceCode} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {RateEntity} from './rate.entity'
import {TenantEntity} from './tenant.entity'


export class ServiceEntity {
  id: string ;
@ApiProperty({
  enum: ServiceCode,
})
code: ServiceCode ;
enabled: boolean ;
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
reservationRateId: string  | null;
reservationRate?: RateEntity  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
reservableSpots: number  | null;
reservationVehicleKinds: string[] ;
reservationHoursMode: string ;
acceptanceMode: string ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
approvalWindowMinutes: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
freeCancelMinutes: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
lateCancelRefundPct: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
earlyArrivalMinutes: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
graceMinutes: number ;
tenantId: string ;
tenant?: TenantEntity ;
}
