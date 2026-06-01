import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Toggles a payment method. Only `enabled` / `isDefault` can be changed;
 * system methods cannot be deleted.
 */
export class TogglePaymentMethodDto {
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
