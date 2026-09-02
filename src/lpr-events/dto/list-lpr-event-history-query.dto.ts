import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';

/**
 * Movement direction of an LPR detection event.
 *
 * The camera pipeline does not yet carry an explicit direction field, so it is
 * derived from the free-text `location`: any value containing `salida` counts
 * as `egreso`, everything else (today only `entrada`) as `ingreso`. When a
 * dedicated exit-lane detection flow lands this derivation keeps working
 * without a contract change.
 */
export const LPR_EVENT_DIRECTIONS = ['ingreso', 'egreso'] as const;
export type LprEventDirection = (typeof LPR_EVENT_DIRECTIONS)[number];

/**
 * Query for the owner-facing LPR event history: detection-timestamp range,
 * plate and direction filters on top of shared offset pagination.
 */
export class ListLprEventHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only events whose detection timestamp (`lastSeenAt`) is at or after this instant (ISO 8601).',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only events whose detection timestamp (`lastSeenAt`) is at or before this instant (ISO 8601).',
    example: '2026-08-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Filter by plate. Case- and format-insensitive prefix match against the normalized plate text (separators and spaces are stripped, letters upper-cased).',
    example: 'AB123CD',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  plate?: string;

  @ApiPropertyOptional({
    enum: LPR_EVENT_DIRECTIONS,
    description:
      'Filter by movement direction. Derived from the camera `location`: values containing "salida" are `egreso`, everything else is `ingreso`.',
  })
  @IsOptional()
  @IsIn(LPR_EVENT_DIRECTIONS)
  direction?: LprEventDirection;
}
