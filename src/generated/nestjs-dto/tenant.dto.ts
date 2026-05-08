import { Prisma } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class TenantDto {
  id: string;
  nombre: string;
  settings: Prisma.JsonValue;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  createdAt: Date;
}
