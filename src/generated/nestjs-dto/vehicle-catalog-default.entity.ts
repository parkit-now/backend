
import {ApiProperty} from '@nestjs/swagger'
import {VehicleCategoryEntity} from './vehicle-category.entity'


export class VehicleCatalogDefaultEntity {
  brand: string ;
model: string ;
@ApiProperty({
  description: `Categoría de la plataforma del modelo (migración 20261005120100). Antes
era \'type_name\', el nombre de un tipo por defecto: el trigger lo resolvía
por nombre y dejaba de encontrarlo si el dueño renombraba. Ahora cuelga
del tipo vivo más antiguo de esa categoría (\'resolve_tenant_vehicle_type\').`,
})
category: string ;
categoryRef?: VehicleCategoryEntity ;
}
