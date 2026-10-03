
import {ApiProperty} from '@nestjs/swagger'


export class VehicleTypeDto {
  id: string ;
name: string ;
accepted: boolean ;
@ApiProperty({
  description: `true si la categoría la adivinó el sistema (backfill, o el alta de una caja
vieja que no manda categoría). La web muestra "Revisá la categoría" hasta
que el dueño la guarda: guardar \'category\' lo apaga.`,
})
categoryInferred: boolean ;
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
