import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';

/** Admin payload to link a user to a parking lot with a per-parking role. */
export class CreateMembershipDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Parking lot the user is being linked to.',
  })
  @IsUUID()
  parkingId: string;

  @ApiProperty({
    enum: MembershipRole,
    description: 'Role to grant at this parking lot: `owner` or `operator`.',
  })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}
