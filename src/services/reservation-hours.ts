/**
 * Horario de reservas (pura). El dueño puede reservar en el horario de
 * apertura (`opening`) o en rangos propios (`custom`), que tienen que caer
 * dentro de la apertura.
 */
import type { ScheduleRange } from '../driver/driver-rules';

/**
 * Índices de los rangos que NO quedan cubiertos por la unión del horario de
 * apertura de su día. Los rangos de apertura que se tocan se unen (8–12 y
 * 12–20 cubren 9–18). Sin horario de apertura, todos quedan afuera.
 */
export function rangesOutsideOpening(
  ranges: readonly ScheduleRange[],
  schedules: readonly ScheduleRange[],
): number[] {
  const mergedByDay = new Map<string, { start: number; end: number }[]>();
  const sorted = [...schedules].sort(
    (left, right) => left.openMinute - right.openMinute,
  );
  for (const schedule of sorted) {
    const merged = mergedByDay.get(schedule.day) ?? [];
    const last = merged[merged.length - 1];
    if (last && schedule.openMinute <= last.end) {
      last.end = Math.max(last.end, schedule.closeMinute);
    } else {
      merged.push({ start: schedule.openMinute, end: schedule.closeMinute });
    }
    mergedByDay.set(schedule.day, merged);
  }

  const outside: number[] = [];
  ranges.forEach((range, index) => {
    const covered = (mergedByDay.get(range.day) ?? []).some(
      (open) => open.start <= range.openMinute && range.closeMinute <= open.end,
    );
    if (!covered) outside.push(index);
  });
  return outside;
}

/** Rangos en los que se puede reservar: los propios o los de apertura. */
export function effectiveReservationHours(
  mode: string,
  schedules: readonly ScheduleRange[],
  ranges: readonly ScheduleRange[],
): ScheduleRange[] {
  const source = mode === 'custom' ? ranges : schedules;
  return source.map(({ day, openMinute, closeMinute }) => ({
    day,
    openMinute,
    closeMinute,
  }));
}
