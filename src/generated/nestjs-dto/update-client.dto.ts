
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateClientDto {
  @IsOptional()
@IsString()
cuit?: string;
@IsOptional()
@IsString()
name?: string;
@IsOptional()
@IsString()
email?: string;
@IsOptional()
@IsString()
phone?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
