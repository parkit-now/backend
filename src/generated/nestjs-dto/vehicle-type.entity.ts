
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {VehicleEntity} from './vehicle.entity'


export class VehicleTypeEntity {
  id: string ;
name: string ;
accepted: boolean ;
tenantId: string ;
tenant?: TenantEntity ;
vehicles?: VehicleEntity[] ;
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
