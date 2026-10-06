import { ApiProperty } from '@nestjs/swagger';
import { ParkingDto } from './parking.dto';

export class DeletionEffectDto {
  @ApiProperty({
    description: 'Qué se intentó.',
    example: 'Desvincular Mercado Pago',
  })
  step: string;

  @ApiProperty({ description: 'Si salió bien.' })
  ok: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Por qué falló, si falló. En inglés: es para el log.',
  })
  detail: string | null;
}

/**
 * El resultado de dar de baja, con el parte de los efectos externos.
 *
 * Los efectos se reportan en vez de tragarse porque ninguno es fatal —la baja
 * es reversible hasta la purga— pero todos importan: un Mercado Pago que no se
 * pudo desvincular es algo que alguien tiene que mirar antes de que la purga
 * borre la fila.
 */
export class DeletionResultDto {
  @ApiProperty({ type: ParkingDto })
  parking: ParkingDto;

  @ApiProperty({
    type: [DeletionEffectDto],
    description:
      'En orden de ejecución. El orden no es cosmético: ver el servicio.',
  })
  effects: DeletionEffectDto[];
}
