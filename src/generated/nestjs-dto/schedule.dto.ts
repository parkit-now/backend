
import {ScheduleDay} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ScheduleDto {
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
