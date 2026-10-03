
import {ApiProperty} from '@nestjs/swagger'
import {VehicleCategoryEntity} from './vehicle-category.entity'


export class VehicleTypeDefaultEntity {
  name: string ;
accepted: boolean ;
@ApiProperty({
  description: `Categoría de la plataforma con la que nace el tipo (migración
20261005120000). El trigger de alta de cuentas la copia a \'vehicle_types\'.`,
})
category: string ;
categoryRef?: VehicleCategoryEntity ;
}
