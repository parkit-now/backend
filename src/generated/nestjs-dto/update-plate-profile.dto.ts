
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdatePlateProfileDto {
  @IsOptional()
@IsString()
plate?: string;
@IsOptional()
@IsString()
vehicleBrand?: string;
@IsOptional()
@IsString()
vehicleModel?: string;
@IsOptional()
@IsString()
vehicleTypeId?: string;
@IsOptional()
@IsString()
vehicleTypeName?: string;
@IsOptional()
@IsString()
color?: string;
@IsOptional()
@IsString()
rateId?: string;
@IsOptional()
@IsString()
rateName?: string;
@IsOptional()
@IsString()
lastEntryId?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
lastEnteredAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
learnAfter?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
