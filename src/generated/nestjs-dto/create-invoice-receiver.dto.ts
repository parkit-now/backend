
import {Type} from 'class-transformer'
import {IsInt,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateInvoiceReceiverDto {
  @IsNotEmpty()
@IsString()
cuit: string;
@IsOptional()
@IsString()
razonSocial?: string;
@ApiProperty({
  description: `\'CondicionIVAReceptorId\' según el padrón. \'null\' = ARCA no tiene datos.`,
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
condicionIvaReceptorId?: number;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
fetchedAt: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
lastUsedAt?: Date;
}
