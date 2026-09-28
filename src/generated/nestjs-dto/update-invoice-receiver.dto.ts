
import {Type} from 'class-transformer'
import {IsInt,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateInvoiceReceiverDto {
  @IsOptional()
@IsString()
cuit?: string;
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
@IsOptional()
@IsRFC3339()
fetchedAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
lastUsedAt?: Date;
}
