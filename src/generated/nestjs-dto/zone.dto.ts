
import {ApiProperty} from '@nestjs/swagger'


export class ZoneDto {
  id: string ;
name: string ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
carSpots: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
motorcycleSpots: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
bicycleSpots: number ;
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
