
import {MembershipRole} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class UserMembershipDto {
  @ApiProperty({
  enum: MembershipRole,
})
role: MembershipRole ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
