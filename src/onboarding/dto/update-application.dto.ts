import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/**
 * Branch declared in the application (before approval). On approval it is
 * materialized as a row in `tenants`.
 */
export class DeclaredBranchInputDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  address: string;
}

/**
 * Editing the application while it is in `draft` or `rejected`. Allows fixing
 * the company data and/or the declared branches.
 */
export class UpdateApplicationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiProperty({ required: false, example: '30123456789' })
  @IsOptional()
  @Matches(/^\d{11}$/, { message: 'CUIT must have 11 digits' })
  cuit?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ type: [DeclaredBranchInputDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeclaredBranchInputDto)
  declaredBranches?: DeclaredBranchInputDto[];
}
