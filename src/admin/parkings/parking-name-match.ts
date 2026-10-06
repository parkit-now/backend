/**
 * Compara el nombre que tipeó el admin contra el del estacionamiento.
 *
 * POR QUÉ NORMALIZAR
 *
 * El nombre se copia y se pega. Una "ó" puede venir como un solo code point
 * (U+00F3, NFC) o como "o" + tilde combinante (U+006F U+0301, NFD) según de
 * dónde salga el texto — macOS entrega NFD en el portapapeles. Los dos se ven
 * IDÉNTICOS en pantalla y `===` dice que son distintos, así que sin
 * `normalize('NFC')` un admin podría tipear el nombre correcto y que el
 * backend lo rechace sin que haya forma de darse cuenta mirando.
 *
 * También se ignoran mayúsculas y espacios de los bordes: nada de eso
 * distingue a un estacionamiento de otro, y endurecerlo sólo agrega intentos
 * fallidos sin agregar seguridad. Lo que la confirmación tiene que evitar es
 * un click distraído sobre la fila equivocada, y para eso alcanza.
 *
 * El front hace exactamente esta normalización antes de habilitar el botón
 * (`front-web/src/features/admin/sections/inventory/parkingNameMatch.ts`). Si
 * las dos divergen, el botón se habilita y el backend rechaza.
 */
export function normalizeParkingName(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('es');
}

/** Si lo tipeado identifica a este estacionamiento. */
export function parkingNameMatches(typed: string, actual: string): boolean {
  return normalizeParkingName(typed) === normalizeParkingName(actual);
}
