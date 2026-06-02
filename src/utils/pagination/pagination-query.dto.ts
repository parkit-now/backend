import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared offset-pagination query parameters.
 *
 * Concrete list queries extend this and add their own filters (e.g. `search`).
 * Swagger reads the inherited decorators, so the `page`/`pageSize` params show
 * up in the generated OpenAPI for every endpoint that uses a subclass.
 *
 * NOTE: every field carries an explicit `@ApiPropertyOptional` because the
 * `@nestjs/swagger` CLI plugin is intentionally NOT enabled in this repo —
 * undecorated properties never reach the OpenAPI document.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    default: 1,
    description: '1-based page number.',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Number of items per page (capped at 100).',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/** Normalizes `page`/`pageSize` and derives the Prisma `skip`/`take`. */
export function resolvePagination(query: PaginationQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
