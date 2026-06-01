import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateBranchDto {
  @ApiPropertyOptional({
    description: 'New display name of the branch.',
    example: 'Palermo Lot',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'New street address of the branch.',
    example: 'Av. Santa Fe 1234, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    enum: ['active', 'maintenance'],
    description: 'New operational status of the branch.',
    example: 'maintenance',
  })
  @IsOptional()
  @IsIn(['active', 'maintenance'])
  status?: 'active' | 'maintenance';
}
