
import {Prisma,BranchStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class TenantDto {
  id: string ;
name: string ;
legalName: string  | null;
cuit: string  | null;
email: string  | null;
phone: string  | null;
address: string  | null;
@ApiProperty({
  enum: BranchStatus,
})
status: BranchStatus ;
settings: Prisma.JsonValue ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
lprImageRetentionDays: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
