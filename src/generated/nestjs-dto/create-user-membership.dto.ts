
import {MembershipRole} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateUserMembershipDto {
  @ApiProperty({
  enum: MembershipRole,
})
@IsNotEmpty()
@IsIn(["owner","operator"])
role: MembershipRole;
}
