
import {ApiProperty} from '@nestjs/swagger'


export class UserTableTemplateMutationDto {
  mutationId: string ;
target: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
