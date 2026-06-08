
import {VehicleType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateVehicleDto {
  @IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
@ApiProperty({
  enum: VehicleType,
})
@IsOptional()
@IsIn(["auto","pickup","suv","van","moto","camioneta","otro"])
type?: VehicleType;
}
