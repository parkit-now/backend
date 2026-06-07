import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ToggleServiceDto {
  @ApiProperty({ description: 'Whether the service is offered by the tenant.' })
  @IsBoolean()
  enabled: boolean;
}
