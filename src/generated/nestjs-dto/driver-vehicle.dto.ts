
import {ApiProperty} from '@nestjs/swagger'


export class DriverVehicleDto {
  id: string ;
plate: string ;
kind: string ;
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
}
