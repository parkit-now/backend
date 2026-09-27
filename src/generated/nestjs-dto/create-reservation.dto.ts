
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateReservationDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
vehiclePlate: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
entryAt: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
exitAt: Date;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
totalArs: Prisma.Decimal;
@IsNotEmpty()
@IsString()
rateSnapshotName: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
rateSnapshotHourPriceArs: Prisma.Decimal;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
cancelledAt?: Date;
}
