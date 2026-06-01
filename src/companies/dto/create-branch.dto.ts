import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateBranchDto {
  @ApiProperty({
    description: 'Display name of the new branch (parking lot).',
    example: 'Palermo Lot',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    description: 'Street address of the branch.',
    example: 'Av. Santa Fe 1234, Buenos Aires',
  })
  @IsOptional()
  @IsString()
  address?: string;
}
