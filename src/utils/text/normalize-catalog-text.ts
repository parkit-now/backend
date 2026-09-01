/**
 * Normaliza texto de catálogo (marca, modelo, nombre de tipo) en un solo lugar
 * para que create y update coincidan con la expresión de los índices únicos
 * (`lower(btrim(...))`). El `btrim()` del índice queda de backstop: sin esto,
 * ' Toyota ' y 'Toyota' entrarían como la misma clave pero se guardarían
 * distinto, y la tabla mostraría espacios sueltos.
 *
 * Lo usan `vehicles/dto` y `vehicle-types/dto`. Vive acá y no en uno de los dos
 * módulos para que no se desincronicen del índice por copiar el regex.
 */
export const normalizeCatalogText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
