
import {ApiProperty} from '@nestjs/swagger'
import {VehicleCategoryEntity} from './vehicle-category.entity'
import {TenantEntity} from './tenant.entity'
import {VehicleEntity} from './vehicle.entity'


export class VehicleTypeEntity {
  id: string ;
name: string ;
accepted: boolean ;
@ApiProperty({
  description: `Categoría de la plataforma (\'vehicle_categories.code\'). El \'name\' es sólo
la etiqueta que el dueño le pone en su playa; esto es lo que usan el
catálogo, el conductor, las reservas, los ingresos y las métricas.`,
})
category: string ;
categoryRef?: VehicleCategoryEntity ;
@ApiProperty({
  description: `true si la categoría la adivinó el sistema (backfill, o el alta de una caja
vieja que no manda categoría). La web muestra "Revisá la categoría" hasta
que el dueño la guarda: guardar \'category\' lo apaga.`,
})
categoryInferred: boolean ;
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
