
import {Prisma,PaymentMethodType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsIn,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePaymentTransactionDto {
  @IsOptional()
@IsString()
paymentMethodId?: string;
@IsOptional()
@IsString()
paymentMethodName?: string;
@ApiProperty({
  enum: PaymentMethodType,
})
@IsOptional()
@IsIn(["transfer","cash","other"])
paymentMethodType?: PaymentMethodType;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
amount?: Prisma.Decimal;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
