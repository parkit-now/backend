import { ApiProperty } from '@nestjs/swagger';

export class RateDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: Number })
  hourPriceArs: number;

  @ApiProperty({ type: Number })
  stayPriceArs: number;

  @ApiProperty({ type: Number })
  fractionPriceArs: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
