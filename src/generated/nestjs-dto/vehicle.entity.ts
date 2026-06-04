
import {ApiProperty} from '@nestjs/swagger'
import {EntryEntity} from './entry.entity'


export class VehicleEntity {
  id: string ;
plate: string  | null;
brand: string ;
model: string ;
type: string  | null;
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
entries?: EntryEntity[] ;
}
