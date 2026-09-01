
import {ServiceCode} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateServiceDto {
  @ApiProperty({
  enum: ServiceCode,
})
@IsOptional()
@IsIn(["ADVANCE_RESERVATION"])
code?: ServiceCode;
}
