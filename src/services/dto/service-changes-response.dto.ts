import { ApiProperty } from '@nestjs/swagger';
import { ServiceDto } from './service.dto';

export class ServiceChangesResponseDto {
  @ApiProperty({ type: () => [ServiceDto] })
  items: ServiceDto[];

  @ApiProperty({
    description: 'Highest sync sequence included in this page.',
    type: Number,
  })
  maxSeq: number;
}
