
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreatePaymentMethodDto {
  @ApiProperty({
  enum: PaymentMethodType,
})
@IsNotEmpty()
@IsIn(["transfer","cash","other","mercadopago_qr"])
type: PaymentMethodType;
@IsNotEmpty()
@IsString()
name: string;
}
