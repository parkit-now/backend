import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class TogglePaymentMethodDto {
  @ApiPropertyOptional({ example: 'Naranja X', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Whether the payment method should be enabled (true) or disabled (false).',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Whether this method becomes the default for the entity.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
