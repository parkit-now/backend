
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateReservationDto {
  @IsOptional()
@IsString()
vehiclePlate?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
entryAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
exitAt?: Date;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
totalArs?: Prisma.Decimal;
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
rateSnapshotFractionPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
rateSnapshotMediaEstadiaPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
rateSnapshotStayPriceArs?: Prisma.Decimal;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
cancelledAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
holdExpiresAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
paidAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
approvalDeadlineAt?: Date;
@IsOptional()
@IsString()
cancelledBy?: string;
@IsOptional()
@IsString()
reason?: string;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
refundedAmountArs?: Prisma.Decimal;
@IsOptional()
@IsString()
refundError?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
refundRequestedAt?: Date;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
refundRequestedArs?: Prisma.Decimal;
@IsOptional()
policySnapshot?: Prisma.InputJsonValue;
}
