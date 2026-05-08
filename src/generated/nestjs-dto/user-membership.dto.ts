import { ApiProperty } from '@nestjs/swagger';

export class UserMembershipDto {
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  createdAt: Date;
}
