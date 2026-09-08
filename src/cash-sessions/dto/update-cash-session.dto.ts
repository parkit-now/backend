import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCashSessionDto {
  @ApiPropertyOptional({
    description:
      'Shift notes. Send an empty string to clear them. Omitting the field leaves them untouched.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
