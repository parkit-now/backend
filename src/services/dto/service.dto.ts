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

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'ADVANCE_RESERVATION: tarifa con la que se cobran las reservas. null = sin configurar.',
  })
  reservationRateId: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'ADVANCE_RESERVATION: plazas que se pueden reservar a la vez. null = sin configurar.',
  })
  reservableSpots: number | null;

  @ApiProperty({
    type: [String],
    description: 'ADVANCE_RESERVATION: tipos de vehículo que pueden reservar.',
  })
  reservationVehicleKinds: string[];

  @ApiProperty({ description: 'ADVANCE_RESERVATION: opening | custom.' })
  reservationHoursMode: string;

  @ApiProperty({ description: 'ADVANCE_RESERVATION: auto | manual.' })
  acceptanceMode: string;

  @ApiProperty({ type: Number })
  approvalWindowMinutes: number;

  @ApiProperty({ type: Number })
  freeCancelMinutes: number;

  @ApiProperty({ type: Number })
  lateCancelRefundPct: number;

  @ApiProperty({ type: Number })
  earlyArrivalMinutes: number;

  @ApiProperty({ type: Number })
  graceMinutes: number;

  @ApiProperty({ type: Number })
  version: number;

  @ApiProperty({ type: Number })
  syncSeq: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}
