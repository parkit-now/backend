import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  LprDetectionStatus,
  LprFormatType,
  LprQualityStatus,
} from '@prisma/client';

export class LprDetectionEventDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ maxLength: 100 })
  cameraId: string;

  @ApiProperty({ maxLength: 50 })
  location: string;

  @ApiProperty({ format: 'date-time' })
  firstSeenAt: Date;

  @ApiProperty({ format: 'date-time' })
  lastSeenAt: Date;

  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  rawText: string | null;

  @ApiPropertyOptional({ maxLength: 20, nullable: true })
  normalizedText: string | null;

  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  displayPlate: string | null;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1 })
  confidence: number;

  @ApiProperty()
  formatValid: boolean;

  @ApiProperty({ enum: LprFormatType })
  formatType: LprFormatType;

  @ApiProperty({ enum: LprQualityStatus })
  qualityStatus: LprQualityStatus;

  @ApiProperty({ enum: LprDetectionStatus })
  status: LprDetectionStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  entryId: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  reviewedAt: Date | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  reviewedByUserId: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  archivedAt: Date | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  archivedByUserId: string | null;

  @ApiPropertyOptional({ nullable: true })
  imageStoragePath: string | null;

  @ApiPropertyOptional({ nullable: true })
  imageUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  bestCaptureId: string | null;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  candidates: unknown[];

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
