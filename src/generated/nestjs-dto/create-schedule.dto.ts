
import {ScheduleDay} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsNotEmpty} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateScheduleDto {
  @ApiProperty({
  enum: ScheduleDay,
})
@IsNotEmpty()
@IsIn(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"])
day: ScheduleDay;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsNotEmpty()
@IsInt()
openMinute: number;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsNotEmpty()
@IsInt()
closeMinute: number;
}
