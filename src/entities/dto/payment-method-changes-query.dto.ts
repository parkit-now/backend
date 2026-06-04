import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class PaymentMethodChangesQueryDto {
  @ApiPropertyOptional({
    type: Number,
    description:
      'Return only payment methods with syncSeq > afterSeq. Defaults to 0 (all records).',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq: number = 0;

  @ApiPropertyOptional({
    type: Number,
    description: 'Maximum number of items to return. Defaults to 500.',
    default: 500,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 500;
}
