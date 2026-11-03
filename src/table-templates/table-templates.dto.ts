import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsUUID,
  IsISO8601,
  ValidateBy,
} from 'class-validator';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function validTableConfig(value: unknown): boolean {
  if (!record(value) || value.version !== 1 || !record(value.columns))
    return false;
  const { visibility, order, pinnedLeft } = value.columns;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    !record(visibility) ||
    !Object.values(visibility).every((v) => typeof v === 'boolean') ||
    !strings(order) ||
    !strings(pinnedLeft)
  )
    return false;
  if (
    !Array.isArray(value.filters) ||
    !value.filters.every(
      (v) => record(v) && typeof v.id === 'string' && Object.hasOwn(v, 'value'),
    )
  )
    return false;
  if (
    !Array.isArray(value.sorting) ||
    !value.sorting.every(
      (v) =>
        record(v) && typeof v.id === 'string' && typeof v.desc === 'boolean',
    )
  )
    return false;
  if (
    typeof value.globalSearch !== 'string' ||
    (value.globalSearchMode !== undefined &&
      typeof value.globalSearchMode !== 'string')
  )
    return false;
  return (
    record(value.pagination) &&
    Number.isInteger(value.pagination.pageSize) &&
    Number(value.pagination.pageSize) >= 1 &&
    Number(value.pagination.pageSize) <= 500
  );
}

export class TableTemplateQueryDto {
  @ApiProperty({ enum: ['web', 'desktop'] })
  @IsIn(['web', 'desktop'])
  platform!: 'web' | 'desktop';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tableKey!: string;
}
export class TableTemplateMutationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  mutationId!: string;
}
export class SaveTableTemplateDto extends TableTemplateMutationDto {
  @ApiProperty({ maxLength: 150 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Version 1 table view: columns, filters, sorting, globalSearch, optional globalSearchMode, pagination.',
  })
  @ValidateBy({
    name: 'isTableViewConfig',
    validator: { validate: validTableConfig },
  })
  config!: Record<string, unknown>;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Legacy creation date, used only during initial import.',
  })
  @IsOptional()
  @IsISO8601()
  createdAt?: string;
}
export class TableTemplateDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: Record<
    string,
    unknown
  >;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: string | null;
}
