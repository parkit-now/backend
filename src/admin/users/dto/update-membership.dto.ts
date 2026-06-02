import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

/** Admin payload to change the role a user holds at a parking lot. */
export class UpdateMembershipDto {
  @ApiProperty({
    enum: MembershipRole,
    description: 'New role at this parking lot: `owner` or `operator`.',
  })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}
