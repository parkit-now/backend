
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePaymentMethodDto {
  @ApiProperty({
  enum: PaymentMethodType,
})
@IsOptional()
@IsIn(["transfer","cash","other","mercadopago_qr"])
type?: PaymentMethodType;
@IsOptional()
@IsString()
name?: string;
}
