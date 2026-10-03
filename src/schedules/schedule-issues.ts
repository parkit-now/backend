export interface ScheduleRangeInput {
  day: string;
  openMinute: number;
  closeMinute: number;
}

export type ScheduleIssueKind = 'invalid_range' | 'overlap';

export interface ScheduleIssue {
  /** Índice del rango problemático dentro del arreglo recibido. */
  index: number;
  kind: ScheduleIssueKind;
  /** Para `overlap`: índice del rango con el que se pisa (el anterior). */
  overlapsWith?: number;
}

/**
 * Chequea en memoria una lista de franjas horarias, con la MISMA regla que
 * `SchedulesService` aplica contra la base (`assertValidRange` +
 * `assertNoOverlap`):
 *
 *  - `closeMinute <= openMinute` es inválido.
 *  - Dos franjas del mismo día se pisan si `a.open < b.close && a.close > b.open`.
 *    Los intervalos son semiabiertos [open, close): 8-12 y 12-20 son
 *    contiguos y NO se pisan.
 *
 * Es pura (sin Nest ni Prisma) para poder usarla desde el onboarding, donde
 * los horarios todavía no existen como filas. Una franja inválida se reporta
 * sólo como `invalid_range` y no entra al chequeo de solapes.
 */
export function findScheduleIssues(
  ranges: readonly ScheduleRangeInput[],
): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const accepted: { index: number; range: ScheduleRangeInput }[] = [];

  ranges.forEach((range, index) => {
    if (range.closeMinute <= range.openMinute) {
      issues.push({ index, kind: 'invalid_range' });
      return;
    }
    const clash = accepted.find(
      (other) =>
        other.range.day === range.day &&
        other.range.openMinute < range.closeMinute &&
        other.range.closeMinute > range.openMinute,
    );
    if (clash) {
      issues.push({ index, kind: 'overlap', overlapsWith: clash.index });
      return;
    }
    accepted.push({ index, range });
  });

  return issues;
}
