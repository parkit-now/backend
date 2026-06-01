
import {Prisma,BranchStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class TenantDto {
  id: string ;
name: string ;
address: string  | null;
@ApiProperty({
  enum: BranchStatus,
})
status: BranchStatus ;
settings: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
