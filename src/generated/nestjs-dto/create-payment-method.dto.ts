
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreatePaymentMethodDto {
  @ApiProperty({
  enum: PaymentMethodType,
})
@IsNotEmpty()
@IsIn(["mp_transfer","cash","other"])
type: PaymentMethodType;
@IsNotEmpty()
@IsString()
name: string;
}
