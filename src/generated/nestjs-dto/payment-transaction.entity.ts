
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {EntryEntity} from './entry.entity'
import {CashSessionEntity} from './cash-session.entity'
import {TenantEntity} from './tenant.entity'


export class PaymentTransactionEntity {
  id: string ;
paymentMethodId: string  | null;
paymentMethodName: string ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
amount: Prisma.Decimal ;
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
updatedAt: Date ;
entryId: string ;
entry?: EntryEntity ;
cashSessionId: string  | null;
cashSession?: CashSessionEntity  | null;
tenantId: string ;
tenant?: TenantEntity ;
}
