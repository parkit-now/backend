
import {Prisma} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'


export class UserTableTemplateEntity {
  userId: string ;
user?: UserEntity ;
platform: string ;
contextKey: string ;
tableKey: string ;
id: string ;
name: string ;
description: string  | null;
config: Prisma.JsonValue ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
deletedAt: Date  | null;
}
