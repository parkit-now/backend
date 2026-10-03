
import {ServiceCode} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsInt,IsNotEmpty,IsOptional} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateServiceDto {
  @ApiProperty({
  enum: ServiceCode,
})
@IsNotEmpty()
@IsIn(["ADVANCE_RESERVATION"])
code: ServiceCode;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
reservableSpots?: number;
}
