
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {InvoiceEntity} from './invoice.entity'


export class ArcaRequestEntity {
  id: string ;
tenantId: string ;
tenant?: TenantEntity ;
invoiceId: string  | null;
invoice?: InvoiceEntity  | null;
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
