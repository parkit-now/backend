import { ApiProperty } from '@nestjs/swagger';
import { ServiceCode } from '@prisma/client';

export class ServiceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({ enum: ServiceCode })
  code: ServiceCode;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
