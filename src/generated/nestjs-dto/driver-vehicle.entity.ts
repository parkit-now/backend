
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'
import {VehicleCategoryEntity} from './vehicle-category.entity'


export class DriverVehicleEntity {
  id: string ;
plate: string ;
category: string ;
brand: string  | null;
model: string  | null;
isPrimary: boolean ;
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
userId: string ;
user?: UserEntity ;
categoryRef?: VehicleCategoryEntity ;
}
