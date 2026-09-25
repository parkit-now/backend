/**
 * Fechas en el formato de ARCA (`AAAAMMDD`), SIEMPRE en hora argentina.
 *
 * `toISOString()` da la fecha en UTC: a partir de las 21:00 de Buenos Aires ya
 * es "mañana", y ARCA rechaza un `CbteFch` futuro. Pasó en el spike de la
 * Etapa 0. Argentina no tiene horario de verano, pero igual se usa la zona y
 * no un `-3` fijo: que lo resuelva `Intl`.
 */
const ARGENTINA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `Date` → `'20260924'` en hora argentina. */
export function toArcaDate(date: Date): string {
  return ARGENTINA_DATE.format(date).replace(/-/g, '');
}

/**
 * `'20260924'` → `Date` a las 00:00 UTC de ese día, que es como Prisma lee y
 * escribe las columnas `@db.Date`. `null` si el string no es una fecha.
 */
export function fromArcaDate(value: string | undefined | null): Date | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const date = new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
