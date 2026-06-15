
import {ApiProperty} from '@nestjs/swagger'


export class WhitelistDto {
  id: string ;
plate: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
validFrom: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
validUntil: Date  | null;
notes: string  | null;
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
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
