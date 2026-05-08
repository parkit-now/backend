import { Prisma } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class EntryDto {
  id: string;
  plate: string;
  color: string | null;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  enteredAt: Date;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  leftAt: Date | null;
  @ApiProperty({
    type: `number`,
    format: `double`,
  })
  amountPaid: Prisma.Decimal | null;
}
