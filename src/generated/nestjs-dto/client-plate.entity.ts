
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {ClientEntity} from './client.entity'


export class ClientPlateEntity {
  id: string ;
tenantId: string ;
tenant?: TenantEntity ;
clientId: string ;
client?: ClientEntity ;
plate: string ;
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
}
