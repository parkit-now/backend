
import {VehicleType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsOptional,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateVehicleDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
brand: string;
@IsNotEmpty()
@IsString()
model: string;
@ApiProperty({
  enum: VehicleType,
})
@IsOptional()
@IsIn(["auto","pickup","suv","van","moto","camioneta","otro"])
type?: VehicleType;
}
