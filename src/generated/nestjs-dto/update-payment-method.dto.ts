
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePaymentMethodDto {
  @ApiProperty({
  enum: PaymentMethodType,
})
@IsOptional()
@IsIn(["mp_transfer","cash","other"])
type?: PaymentMethodType;
@IsOptional()
@IsString()
name?: string;
}
