
import {ScheduleDay} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ReservationHourDto {
  id: string ;
@ApiProperty({
  enum: ScheduleDay,
})
day: ScheduleDay ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
openMinute: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
closeMinute: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
