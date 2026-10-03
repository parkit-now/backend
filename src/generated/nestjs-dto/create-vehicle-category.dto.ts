
import {Type} from 'class-transformer'
import {IsInt,IsNotEmpty,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateVehicleCategoryDto {
  @IsNotEmpty()
@IsString()
code: string;
@IsNotEmpty()
@IsString()
label: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsNotEmpty()
@IsInt()
sortOrder: number;
}
