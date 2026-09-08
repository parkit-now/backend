
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreatePaymentTransactionDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsOptional()
@IsString()
paymentMethodId?: string;
@IsNotEmpty()
@IsString()
paymentMethodName: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
amount: Prisma.Decimal;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
