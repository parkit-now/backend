
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateVehicleTypeDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
name: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
