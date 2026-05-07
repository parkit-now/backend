import { UserRole } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({
    enum: UserRole,
  })
  @IsOptional()
  @IsIn(['admin', 'owner', 'operator', 'driver'])
  role?: UserRole;
  @IsOptional()
  @IsString()
  email?: string;
}
