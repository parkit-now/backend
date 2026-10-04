
import {ServiceCode} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ServiceDto {
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
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
reservableSpots: number  | null;
reservationVehicleCategories: string[] ;
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
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
earlyArrivalMaxMinutes: number ;
}
