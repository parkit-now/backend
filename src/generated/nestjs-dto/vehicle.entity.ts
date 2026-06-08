
import {VehicleType} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'


export class VehicleEntity {
  id: string ;
brand: string ;
model: string ;
@ApiProperty({
  enum: VehicleType,
})
type: VehicleType  | null;
tenantId: string  | null;
tenant?: TenantEntity  | null;
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
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
