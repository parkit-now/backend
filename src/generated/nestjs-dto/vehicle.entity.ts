
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {VehicleTypeEntity} from './vehicle-type.entity'


export class VehicleEntity {
  id: string ;
brand: string ;
model: string ;
tenantId: string ;
typeId: string ;
tenant?: TenantEntity ;
type?: VehicleTypeEntity ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
syncSeq: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
version: number ;
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
