import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  LprDetectionStatus,
  LprFormatType,
  LprQualityStatus,
} from '@prisma/client';
import { PlateBboxDto } from './plate-bbox.dto';

export class UpsertLprDetectionEventDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  cameraId: string;

  @ApiProperty({ maxLength: 50 })
  @IsString()
  @MaxLength(50)
  location: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  firstSeenAt: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  lastSeenAt: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  rawText?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  normalizedText?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  displayPlate?: string;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence: number;

  @ApiProperty()
  @IsBoolean()
  formatValid: boolean;

  @ApiProperty({ enum: LprFormatType })
  @IsEnum(LprFormatType)
  formatType: LprFormatType;

  @ApiProperty({ enum: LprQualityStatus })
  @IsEnum(LprQualityStatus)
  qualityStatus: LprQualityStatus;

  @ApiPropertyOptional({ enum: LprDetectionStatus, default: 'pending' })
  @IsOptional()
  @IsEnum(LprDetectionStatus)
  status?: LprDetectionStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entryId?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  reviewedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bestCaptureId?: string;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  candidates?: unknown[];

  @ApiPropertyOptional({ type: PlateBboxDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlateBboxDto)
  plateBbox?: PlateBboxDto;
}
