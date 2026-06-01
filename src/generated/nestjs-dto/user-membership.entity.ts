
import {MembershipRole} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'
import {TenantEntity} from './tenant.entity'


export class UserMembershipEntity {
  userId: string ;
tenantId: string ;
@ApiProperty({
  enum: MembershipRole,
})
role: MembershipRole ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
user?: UserEntity ;
tenant?: TenantEntity ;
}
