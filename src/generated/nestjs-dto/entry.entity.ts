import { Prisma } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { VehicleEntity } from './vehicle.entity';
import { TenantEntity } from './tenant.entity';

export class EntryEntity {
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
  vehicleId: string;
  vehicle?: VehicleEntity;
  tenantId: string;
  tenant?: TenantEntity;
}
