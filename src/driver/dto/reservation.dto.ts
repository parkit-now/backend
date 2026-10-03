import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsString, IsUUID, Matches } from 'class-validator';
import { normalizePlate } from '../driver-rules';

export class CreateReservationDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera el cliente: es la clave de idempotencia. Reintentar con el ' +
      'mismo id devuelve la reserva ya creada.',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  parkingId: string;

  @ApiProperty({
    example: 'AB123CD',
    description: 'Se normaliza (mayúsculas, sin espacios ni guiones).',
  })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePlate(value) : value,
  )
  @Matches(/^[A-Z0-9]{3,10}$/)
  vehiclePlate: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T10:00:00-03:00' })
  @IsDateString()
  entryAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T13:00:00-03:00' })
  @IsDateString()
  exitAt: string;
}

export enum DriverReservationStateDto {
  active = 'active',
  completed = 'completed',
  cancelled = 'cancelled',
}

export class DriverReservationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Código corto para mostrar (R-XXXXXX).' })
  code: string;

  @ApiProperty({
    enum: DriverReservationStateDto,
    enumName: 'DriverReservationState',
  })
  state: DriverReservationStateDto;

  @ApiProperty({ description: 'Se puede cancelar (activa y sin empezar).' })
  cancellable: boolean;

  @ApiProperty({ format: 'uuid' })
  parkingId: string;

  @ApiProperty()
  parkingName: string;

  @ApiProperty({ type: String, nullable: true })
  parkingAddress: string | null;

  @ApiProperty({ type: Number, nullable: true })
  latitude: number | null;

  @ApiProperty({ type: Number, nullable: true })
  longitude: number | null;

  @ApiProperty()
  vehiclePlate: string;

  @ApiProperty({ format: 'date-time' })
  entryAt: string;

  @ApiProperty({ format: 'date-time' })
  exitAt: string;

  @ApiProperty({ type: Number })
  totalArs: number;

  @ApiProperty()
  rateName: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
