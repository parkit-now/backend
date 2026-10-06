
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateLprIgnoredPlateDto {
  @IsOptional()
@IsString()
plate?: string;
@IsOptional()
@IsString()
notes?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
validFrom?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
validUntil?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
