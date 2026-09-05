import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class DeleteVehicleTypeQueryDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'Versión que el cliente cree vigente. Si no coincide, 409: otra persona ' +
      'modificó el tipo.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo al que se mueven los vehículos que todavía usan el que se borra. ' +
      'Obligatorio si hay al menos uno: sin esto la respuesta es 409 ' +
      '`VEHICLE_TYPE_IN_USE`. Para mandarlos a un tipo nuevo, crealo primero ' +
      'con POST — el id lo genera el cliente, así que ya lo conocés.',
  })
  @IsOptional()
  @IsUUID()
  reassignToTypeId?: string;
}

export class DeleteVehicleTypeResultDto {
  @ApiProperty({
    type: Number,
    description:
      'Cuántos vehículos se movieron al tipo destino. Cada uno recibe su ' +
      'propio `syncSeq` y `version`, así que viajan por /vehicles/changes.',
  })
  reassignedVehicles: number;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'El tipo destino, o null si no hizo falta reasignar nada.',
  })
  reassignedToTypeId: string | null;
}
