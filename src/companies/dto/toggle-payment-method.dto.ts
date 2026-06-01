import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Only enabling/disabling is allowed. System methods cannot be deleted. */
export class TogglePaymentMethodDto {
  @ApiProperty({
    description:
      'Whether the payment method should be enabled (true) or disabled (false).',
    example: true,
  })
  @IsBoolean()
  enabled: boolean;
}
