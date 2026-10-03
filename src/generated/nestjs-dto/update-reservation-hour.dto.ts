
import {ScheduleDay} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsOptional} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateReservationHourDto {
  @ApiProperty({
  enum: ScheduleDay,
})
@IsOptional()
@IsIn(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"])
day?: ScheduleDay;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
openMinute?: number;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
closeMinute?: number;
}
