
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ArcaRequestDto {
  id: string ;
operation: string ;
requestJson: Prisma.JsonValue  | null;
responseJson: Prisma.JsonValue  | null;
error: string  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
durationMs: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
