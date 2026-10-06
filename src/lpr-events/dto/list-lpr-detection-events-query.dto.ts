import { ApiPropertyOptional } from '@nestjs/swagger';
import { LprDetectionStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../utils/pagination/pagination-query.dto';

export class ListLprDetectionEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LprDetectionStatus })
  @IsOptional()
  @IsEnum(LprDetectionStatus)
  status?: LprDetectionStatus;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'When false (default), archived LPR events are hidden from review lists. Set true to list archived events instead.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    const raw = value as unknown;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  })
  @IsBoolean()
  archived = false;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only include events first detected at or after this timestamp (ISO 8601, inclusive).',
  })
  @IsOptional()
  @IsDateString()
  firstSeenFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only include events first detected at or before this timestamp (ISO 8601, inclusive).',
  })
  @IsOptional()
  @IsDateString()
  firstSeenTo?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Comma-separated entry IDs. When present, only events linked to those entries are returned.',
    example:
      '018f4f8a-5f47-7bb8-a09c-8b6cf2f49d95,018f4f8a-6000-7339-a76a-84eb1f6a3f0a',
  })
  @IsOptional()
  // `value: unknown` y no el `any` que tipa class-transformer: devolverlo
  // crudo sería un `any` saliendo del decorador, que es lo que corta el lint.
  // El valor que no es ni string ni array se devuelve TAL CUAL a propósito,
  // para que `@IsArray()` lo rechace con un error de validación legible en vez
  // de que lo coercionemos en silencio a algo que no pidió nadie.
  @Transform(({ value }: { value: unknown }) => {
    const split = (raw: unknown): string[] =>
      String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    // Repetido en la query (`?entryIds=a&entryIds=b`) llega como array, y cada
    // elemento puede traer a su vez varios separados por coma.
    if (Array.isArray(value)) return (value as unknown[]).flatMap(split);
    if (typeof value !== 'string') return value;
    return split(value);
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  entryIds?: string[];
}
