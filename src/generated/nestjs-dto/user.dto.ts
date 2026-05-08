import { UserRole } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  id: string;
  @ApiProperty({
    enum: UserRole,
  })
  role: UserRole;
  email: string;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  createdAt: Date;
}
