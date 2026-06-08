
import {ServiceCode} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateServiceDto {
  @ApiProperty({
  enum: ServiceCode,
})
@IsNotEmpty()
@IsIn(["ADVANCE_RESERVATION","VEHICLE_CAR","VEHICLE_ELECTRIC","VEHICLE_BICYCLE","VEHICLE_MOTORCYCLE","VEHICLE_PICKUP","VEHICLE_TRUCK"])
code: ServiceCode;
}
