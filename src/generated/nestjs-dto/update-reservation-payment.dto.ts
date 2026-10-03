
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateReservationPaymentDto {
  @ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
amountArs?: Prisma.Decimal;
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
