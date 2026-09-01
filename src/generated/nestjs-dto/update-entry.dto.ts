
import {Prisma,VehicleBodyType} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsIn,IsInt,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateEntryDto {
  @IsOptional()
@IsString()
plate?: string;
@IsOptional()
@IsString()
color?: string;
@IsOptional()
@IsString()
cochera?: string;
@IsOptional()
@IsString()
notes?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
leftAt?: Date;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
amountPaid?: Prisma.Decimal;
@ApiProperty({
  enum: VehicleBodyType,
})
@IsOptional()
@IsIn(["auto","moto","bici","suv","pickup","van","camion","otro"])
vehicleType?: VehicleBodyType;
@IsOptional()
@IsString()
entryImageUrl?: string;
@IsOptional()
@IsString()
entryCameraId?: string;
@IsOptional()
@IsString()
exitImageUrl?: string;
@IsOptional()
@IsString()
exitCameraId?: string;
@IsOptional()
@IsString()
rateSnapshotName?: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
rateSnapshotHourPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
rateSnapshotStayPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
rateSnapshotFractionPriceArs?: Prisma.Decimal;
@IsOptional()
@IsString()
vehicleBrand?: string;
@IsOptional()
@IsString()
vehicleModel?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
ticketNumber?: number;
}
