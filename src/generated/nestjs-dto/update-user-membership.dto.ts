
import {MembershipRole} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsOptional} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateUserMembershipDto {
  @ApiProperty({
  enum: MembershipRole,
})
@IsOptional()
@IsIn(["owner","operator"])
role?: MembershipRole;
}
