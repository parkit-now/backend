
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {EntryEntity} from './entry.entity'


export class TenantEntity {
  id: string ;
nombre: string ;
settings: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
memberships?: UserMembershipEntity[] ;
entries?: EntryEntity[] ;
}
