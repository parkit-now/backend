
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateReservationPaymentDto {
  @ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
amountArs: Prisma.Decimal;
@IsOptional()
@IsString()
providerPreferenceId?: string;
@IsOptional()
@IsString()
checkoutUrl?: string;
@IsOptional()
@IsString()
providerPaymentId?: string;
@ApiProperty({
  description: `Estado CRUDO del proveedor. String y no enum: puede sumar valores.`,
})
@IsOptional()
@IsString()
providerStatus?: string;
@IsOptional()
@IsString()
providerStatusDetail?: string;
@IsOptional()
@IsString()
returnUrl?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
approvedAt?: Date;
}
