
import {ApiProperty} from '@nestjs/swagger'


export class InvoiceReceiverDto {
  id: string ;
cuit: string ;
razonSocial: string  | null;
@ApiProperty({
  description: `\'CondicionIVAReceptorId\' según el padrón. \'null\' = ARCA no tiene datos.`,
  type: `integer`,
  format: `int32`,
})
condicionIvaReceptorId: number  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
fetchedAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
lastUsedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
