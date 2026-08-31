
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsInt,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateRateDto {
  @IsOptional()
@IsString()
name?: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
hourPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
stayPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
fractionPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
shortcutNumber?: number;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
