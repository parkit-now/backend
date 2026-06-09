
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePaymentTransactionDto {
  @IsOptional()
@IsString()
paymentMethodId?: string;
@IsOptional()
@IsString()
paymentMethodName?: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
amount?: Prisma.Decimal;
}
