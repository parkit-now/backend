import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LprDetectionStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';

export class UpdateLprDetectionEventDto {
  @ApiProperty({
    enum: LprDetectionStatus,
    description: 'New review/suppression status for the detection event.',
  })
  @IsEnum(LprDetectionStatus)
  status: LprDetectionStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Entry created from this event, required by registered events.',
  })
  @IsOptional()
  @IsUUID()
  entryId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Client-side action timestamp. Defaults to server time.',
  })
  @IsOptional()
  @IsDateString()
  reviewedAt?: string;
}
