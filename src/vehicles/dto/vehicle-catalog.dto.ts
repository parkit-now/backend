import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class VehicleCatalogItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Toyota' })
  brand: string;

  @ApiProperty({ example: 'Corolla' })
  model: string;

  @ApiPropertyOptional({ example: 'auto' })
  type: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'null = global (admin-managed), UUID = tenant-specific.',
  })
  tenantId: string | null;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Non-null when the vehicle has been soft-deleted.',
  })
  deletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class VehicleCatalogChangesResponseDto {
  @ApiProperty({ type: [VehicleCatalogItemDto] })
  items: VehicleCatalogItemDto[];

  @ApiProperty({ type: Number })
  maxSeq: number;
}

export class VehicleCatalogChangesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  afterSeq: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit: number = 1000;
}
