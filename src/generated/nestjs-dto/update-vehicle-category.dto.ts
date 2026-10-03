
import {Type} from 'class-transformer'
import {IsInt,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateVehicleCategoryDto {
  @IsOptional()
@IsString()
label?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
sortOrder?: number;
}
