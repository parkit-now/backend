
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateClientDto {
  @IsNotEmpty()
@IsString()
id: string;
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
