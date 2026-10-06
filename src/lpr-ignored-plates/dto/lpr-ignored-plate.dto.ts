import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export function normalizeIgnoredPlate(value: string): string {
  return value.replace(/[\s_-]/g, '').toUpperCase();
}

// Client IDs, normalization and date-only bounds are part of the sync contract.
export class CreateLprIgnoredPlateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ maxLength: 20, example: 'IAG574' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeIgnoredPlate(value) : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{1,20}$/)
  plate: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ description: 'Defaults to true when omitted.' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ format: 'date', nullable: true, type: String })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  validFrom?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true, type: String })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  validUntil?: string | null;
}

export class UpdateLprIgnoredPlateDto extends PartialType(
  OmitType(CreateLprIgnoredPlateDto, ['id'] as const),
  { skipNullProperties: false },
) {}

export class LprIgnoredPlateDto extends OmitType(CreateLprIgnoredPlateDto, [
  'active',
] as const) {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  active: boolean;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  deletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class LprIgnoredPlateChangesDto {
  @ApiProperty({ type: [LprIgnoredPlateDto] })
  items: LprIgnoredPlateDto[];

  @ApiProperty({ type: Number })
  maxSeq: number;
}

export class LprIgnoredPlateChangesQueryDto {
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq = 0;

  @ApiPropertyOptional({ default: 1000, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 1000;
}
