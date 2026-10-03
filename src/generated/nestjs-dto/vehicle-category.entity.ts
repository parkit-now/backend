
import {ApiProperty} from '@nestjs/swagger'
import {VehicleTypeDefaultEntity} from './vehicle-type-default.entity'
import {VehicleCatalogDefaultEntity} from './vehicle-catalog-default.entity'
import {VehicleTypeEntity} from './vehicle-type.entity'
import {EntryEntity} from './entry.entity'


export class VehicleCategoryEntity {
  code: string ;
label: string ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
sortOrder: number ;
reservable: boolean ;
typeDefaults?: VehicleTypeDefaultEntity[] ;
catalogDefaults?: VehicleCatalogDefaultEntity[] ;
vehicleTypes?: VehicleTypeEntity[] ;
entries?: EntryEntity[] ;
}
