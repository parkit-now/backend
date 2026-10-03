
import {ApiProperty} from '@nestjs/swagger'


export class VehicleCategoryDto {
  code: string ;
label: string ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
sortOrder: number ;
reservable: boolean ;
}
