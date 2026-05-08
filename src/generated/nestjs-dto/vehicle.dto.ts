import { ApiProperty } from '@nestjs/swagger';

export class VehicleDto {
  id: string;
  brand: string;
  model: string;
  type: string | null;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  createdAt: Date;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  updatedAt: Date;
}
