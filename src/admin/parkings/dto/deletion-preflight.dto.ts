import { ApiProperty } from '@nestjs/swagger';

/**
 * Lo que se va a destruir si se borra este estacionamiento.
 *
 * Existe porque el borrado anterior era un solo click sobre un diálogo que no
 * decía cuánto se llevaba puesto. Acá los números van ANTES de la confirmación
 * y se guardan en la auditoría junto con la baja, así que después se puede
 * reconstruir qué había en el momento de borrar.
 *
 * Nada de esto bloquea: la decisión es del admin. Lo que `blockers` separa es
 * la plata que quedaría colgada, para poder mostrarla distinto.
 */
export class DeletionPreflightDto {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty({
    description:
      'Nombre exacto que hay que tipear para confirmar. Se compara ' +
      'normalizado (NFC, sin distinguir mayúsculas ni espacios del borde).',
  })
  name: string;

  @ApiProperty({
    description: 'Personal con membresía en este estacionamiento.',
  })
  staff: number;

  @ApiProperty({ description: 'Autos que están adentro ahora mismo.' })
  carsInside: number;

  @ApiProperty({ description: 'Ingresos registrados, históricos incluidos.' })
  entries: number;

  @ApiProperty({ description: 'Turnos de caja abiertos sin cerrar.' })
  openCashSessions: number;

  @ApiProperty({ description: 'Turnos de caja en total.' })
  cashSessions: number;

  @ApiProperty({ description: 'Facturas emitidas por ARCA.' })
  invoices: number;

  @ApiProperty({
    description:
      'Fotos de patentes en el bucket privado. Las borra la purga: hoy ' +
      'ningún otro camino del backend las toca al borrar un estacionamiento.',
  })
  storageObjects: number;

  @ApiProperty({
    description:
      'Filas de auditoría. Hasta ahora NO se borraban: la FK es ON DELETE ' +
      'SET NULL, así que quedaban anonimizadas e irrastreables. La purga las ' +
      'borra de verdad.',
  })
  auditRows: number;

  @ApiProperty({
    description: 'Reservas de conductores, históricas incluidas.',
  })
  reservations: number;

  @ApiProperty({ description: 'Si tiene Mercado Pago vinculado.' })
  mercadoPagoLinked: boolean;

  @ApiProperty({ description: 'Si tiene ARCA vinculado para facturar.' })
  arcaLinked: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Plata de terceros que quedaría colgada. Se muestra en rojo y obliga a ' +
      'leer, pero NO impide borrar: el admin decide. La purga definitiva sí ' +
      'los respeta, porque ahí ya no hay vuelta atrás.',
    example: ['2 reembolsos pendientes', '1 cobro acreditado sin aplicar'],
  })
  blockers: string[];
}
