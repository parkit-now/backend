
import {ApiProperty} from '@nestjs/swagger'


export class ClientPlateDto {
  id: string ;
plate: string ;
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
}
