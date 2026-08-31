import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ExpectedVersionQueryDto {
  @ApiProperty({
    description:
      'Expected current version of the row. Used for optimistic locking.',
    minimum: 1,
    example: 3,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
