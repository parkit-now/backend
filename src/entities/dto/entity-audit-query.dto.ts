import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { AuditSeverity } from '@prisma/client';

export class EntityAuditQueryDto {
  @ApiPropertyOptional({
    enum: ['info', 'warn', 'crit'],
    description:
      'Filter events by severity. Returns all severities when omitted.',
    example: 'warn',
  })
  @IsOptional()
  @IsIn(['info', 'warn', 'crit'])
  severity?: AuditSeverity;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 500,
    default: 100,
    description: 'Maximum number of audit events to return.',
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
