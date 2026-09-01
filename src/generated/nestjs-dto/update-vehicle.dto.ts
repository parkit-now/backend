
import {VehicleBodyType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateVehicleDto {
  @IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
@ApiProperty({
  enum: VehicleBodyType,
})
@IsOptional()
@IsIn(["auto","moto","bici","suv","pickup","van","camion","otro"])
type?: VehicleBodyType;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
