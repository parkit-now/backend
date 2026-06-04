
import {ApiProperty} from '@nestjs/swagger'


export class VehicleDto {
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
}
