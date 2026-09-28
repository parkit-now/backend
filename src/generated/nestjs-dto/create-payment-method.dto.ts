
import {PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
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
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
