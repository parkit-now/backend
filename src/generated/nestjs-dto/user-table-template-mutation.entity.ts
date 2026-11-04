
import {ApiProperty} from '@nestjs/swagger'
import {UserEntity} from './user.entity'


export class UserTableTemplateMutationEntity {
  userId: string ;
user?: UserEntity ;
mutationId: string ;
target: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
