
import {VehicleType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
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
@IsIn(["auto","moto","bici","suv","pickup","van","camion","otro"])
type?: VehicleType;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
