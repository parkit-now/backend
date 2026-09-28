
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional,IsRFC3339,IsString} from 'class-validator'
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
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
