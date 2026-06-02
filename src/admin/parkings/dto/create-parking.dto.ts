import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Admin payload to create a parking lot with its basic data, without attaching
 * any owner/operator. Ownership is granted separately via memberships
 * (`POST /admin/users/:id/memberships`).
 */
export class CreateParkingDto {
  @ApiProperty({ description: 'Display name of the parking lot.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: 'Registered legal/company name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalName?: string;

  @ApiPropertyOptional({ description: 'Tax id (CUIT).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  cuit?: string;

  @ApiPropertyOptional({ description: 'Contact email.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Contact phone.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ description: 'Street address.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional({
    enum: BranchStatus,
    default: BranchStatus.active,
    description: 'Initial operational status. Defaults to `active`.',
  })
  @IsOptional()
  @IsEnum(BranchStatus)
  status?: BranchStatus;
}
