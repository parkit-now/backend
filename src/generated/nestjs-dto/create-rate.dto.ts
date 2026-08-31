
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsInt,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateRateDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
name: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
hourPriceArs: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
stayPriceArs: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
fractionPriceArs: Prisma.Decimal;
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
