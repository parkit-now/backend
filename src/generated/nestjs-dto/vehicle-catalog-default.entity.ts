
import {ApiProperty} from '@nestjs/swagger'
import {VehicleTypeDefaultEntity} from './vehicle-type-default.entity'


export class VehicleCatalogDefaultEntity {
  brand: string ;
model: string ;
@ApiProperty({
  description: `Nombre del tipo por defecto. FK a \'vehicle_type_defaults.name\' para que
el generador no pueda emitir un tipo inexistente.`,
})
typeName: string ;
defaultType?: VehicleTypeDefaultEntity ;
}
