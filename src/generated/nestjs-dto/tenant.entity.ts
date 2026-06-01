
import {Prisma,BranchStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {CompanyEntity} from './company.entity'
import {UserMembershipEntity} from './user-membership.entity'
import {EntryEntity} from './entry.entity'
import {ZoneEntity} from './zone.entity'


export class TenantEntity {
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
companyId: string  | null;
company?: CompanyEntity  | null;
memberships?: UserMembershipEntity[] ;
entries?: EntryEntity[] ;
zones?: ZoneEntity[] ;
}
