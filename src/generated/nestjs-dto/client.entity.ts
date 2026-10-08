
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {ClientPlateEntity} from './client-plate.entity'


export class ClientEntity {
  id: string ;
tenantId: string ;
tenant?: TenantEntity ;
cuit: string  | null;
name: string  | null;
nameEdited: boolean ;
email: string  | null;
phone: string  | null;
plates?: ClientPlateEntity[] ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
version: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
syncSeq: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
deletedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
