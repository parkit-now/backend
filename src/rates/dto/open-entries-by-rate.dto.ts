import { ApiProperty } from '@nestjs/swagger';

export class OpenEntriesForRateDto {
  @ApiProperty({ format: 'uuid' })
  rateId: string;

  @ApiProperty({ type: Number, description: 'Autos adentro con esta tarifa.' })
  openEntries: number;
}

/**
 * Cuántos autos hay adentro con cada tarifa.
 *
 * Existe para que la app web sepa si tiene sentido preguntar antes de guardar
 * una edición de precios: si no hay autos adentro con esa tarifa, no hay nada
 * que decidir y no se molesta al dueño.
 *
 * Va en un endpoint aparte y NO como un campo de `RateDto`, a propósito: ese
 * DTO es también el payload del feed de sync, así que un contador volátil
 * terminaría guardado en la base local del desktop mintiendo apenas entre un
 * auto.
 */
export class OpenEntriesByRateDto {
  @ApiProperty({ type: [OpenEntriesForRateDto] })
  counts: OpenEntriesForRateDto[];

  @ApiProperty({
    type: Number,
    description:
      'Autos adentro SIN tarifa asignada — los que creó la cámara. No los ' +
      'alcanza ninguna propagación porque no tienen precio congelado.',
  })
  withoutRate: number;
}
