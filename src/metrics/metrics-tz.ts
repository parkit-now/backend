/**
 * Civil-day helpers for the metrics module.
 *
 * Everything in the DB is stored in UTC and `tenants` has no timezone column,
 * so "revenue for today" is ambiguous on its own: at 01:00 UTC it is still the
 * previous day in Argentina. Metrics endpoints therefore take an IANA `tz`
 * (defaulting to `DEFAULT_TIME_ZONE`) and bucket by the civil day as seen in
 * that zone.
 *
 * No new dependency: the zone math rides on `Intl.DateTimeFormat`, which knows
 * the full IANA database including historical/DST offsets.
 *
 * DELIBERATE LIMITATION — a day runs midnight to midnight. A lot trading past
 * midnight has its small hours booked to the following day: a car entering
 * Friday 23:00 and leaving Saturday 02:00 pays into Saturday, even though the
 * operator closing the shift at 03:00 counts it as Friday night's take. The
 * schedules schema already draws the boundary the same way — `close_minute`
 * caps at 1440, so an overnight lot is stored as two ranges rather than one
 * crossing midnight. Should overnight lots need their night kept whole, the
 * fix is a configurable cutoff (business day = civil day of `instant - cutoff`,
 * with `0` reproducing today's behaviour); `tenant.settings` is free-form JSON,
 * so it would persist there without a migration. `cash_sessions` is the other
 * candidate anchor — it is what the operator actually reconciles — at the cost
 * of no longer lining up with the calendar.
 */

/** Default civil timezone for metrics (the product ships in Argentina). */
export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** A civil date with no time component, formatted `YYYY-MM-DD`. */
export type DayKey = string;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * `en-CA` renders dates as `YYYY-MM-DD`, which is exactly the `DayKey` shape.
 * Formatters are cached per zone: building one is expensive and the metrics
 * endpoints call these helpers in tight loops when bucketing a 30-day range.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(tz, formatter);
  }
  return formatter;
}

function partFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partFormatters.set(tz, formatter);
  }
  return formatter;
}

/** The `YYYY-MM-DD` civil day `instant` falls on, as seen in `tz`. */
export function dayKeyIn(instant: Date, tz: string): DayKey {
  return dayFormatterFor(tz).format(instant);
}

/**
 * Offset of `tz` at `instant`, in ms east of UTC.
 *
 * Trick: render the instant's wall-clock fields in `tz`, then reinterpret
 * those same fields as if they were UTC. The gap between that and the real
 * instant *is* the offset.
 */
function offsetMsAt(instant: Date, tz: string): number {
  const parts = partFormatterFor(tz).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  // `hour12: false` renders midnight as `24` in some ICU versions.
  const hour = field('hour') % 24;
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant matching a wall-clock reading in `tz`.
 *
 * Inverse of `offsetMsAt`, and unavoidably iterative: the offset to subtract
 * depends on the instant we are still solving for. The first pass guesses the
 * offset by treating the wall clock as UTC; the second re-measures it at that
 * candidate. Two passes settle DST boundaries, where the offset just before
 * and just after the reading differ.
 */
function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  const firstGuess = wallClock - offsetMsAt(new Date(wallClock), tz);
  const settled = wallClock - offsetMsAt(new Date(firstGuess), tz);
  return new Date(settled);
}

/** The UTC instant at which the civil day `dayKey` starts in `tz`. */
function startOfDayIn(dayKey: DayKey, tz: string): Date {
  assertDayKey(dayKey);
  const [year, month, day] = dayKey.split('-').map(Number);
  return instantFromWallClock(year, month, day, 0, tz);
}

/**
 * Half-open UTC range `[gte, lt)` covering the civil day `dayKey` in `tz`.
 *
 * Half-open on purpose: an inclusive `lte` would double-count anything landing
 * exactly on midnight into both adjacent days.
 */
export function dayRangeIn(
  dayKey: DayKey,
  tz: string,
): { gte: Date; lt: Date } {
  return {
    gte: startOfDayIn(dayKey, tz),
    lt: startOfDayIn(shiftDayKey(dayKey, 1), tz),
  };
}

/**
 * Moves a `DayKey` by `days` on the civil calendar (negative goes back).
 *
 * Pure calendar arithmetic on the key itself — never on an instant — so it is
 * immune to the 23/25-hour days a DST transition produces.
 */
export function shiftDayKey(dayKey: DayKey, days: number): DayKey {
  assertDayKey(dayKey);
  const [year, month, day] = dayKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The slice of the civil day `dayKey` matching the first `elapsedMs` of it.
 *
 * Powers the dashboard's day-over-day comparison: contrasting a full previous
 * day against today-so-far would show a fake slump every morning, so the
 * baseline is truncated to the same elapsed offset. Clamped to the day's real
 * end, since a DST day can be shorter than the elapsed window.
 */
export function partialDayRangeIn(
  dayKey: DayKey,
  tz: string,
  elapsedMs: number,
): { gte: Date; lt: Date } {
  const { gte, lt } = dayRangeIn(dayKey, tz);
  const truncated = new Date(gte.getTime() + Math.max(elapsedMs, 0));
  return { gte, lt: truncated < lt ? truncated : lt };
}

function assertDayKey(dayKey: string): void {
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new Error(
      `[metrics-tz] Invalid day key '${dayKey}'. Expected format YYYY-MM-DD.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bucketing — splitting an arbitrary instant range into calendar buckets
// ---------------------------------------------------------------------------

/** Bucket width for a metrics time series. */
export type Granularity = 'hour' | 'day' | 'week' | 'month';

/**
 * One bucket of a series: a label plus the half-open instant range it covers.
 * The range is clipped to the caller's window, so the first and last buckets
 * of a series are usually partial.
 */
export type Bucket = { key: string; gte: Date; lt: Date };

/**
 * Ceiling on how many buckets one request may produce.
 *
 * A year at hourly granularity is ~8,760 buckets — a response no chart can use
 * and a payload no client wants. Callers are expected to check
 * `exceedsBucketLimit` and reject with a validation error rather than let the
 * series balloon.
 */
export const MAX_BUCKETS = 1000;

/** Local wall-clock fields, truncated to the hour. */
type WallClock = { year: number; month: number; day: number; hour: number };

function wallClockIn(instant: Date, tz: string): WallClock {
  const parts = partFormatterFor(tz).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour') % 24,
  };
}

function dayKeyOf(wc: WallClock): DayKey {
  const mm = String(wc.month).padStart(2, '0');
  const dd = String(wc.day).padStart(2, '0');
  return `${wc.year}-${mm}-${dd}`;
}

function wallClockFromDayKey(dayKey: DayKey, hour: number): WallClock {
  const [year, month, day] = dayKey.split('-').map(Number);
  return { year, month, day, hour };
}

/** Rounds a wall clock down to the start of its bucket. */
function truncate(wc: WallClock, granularity: Granularity): WallClock {
  switch (granularity) {
    case 'hour':
      return wc;
    case 'day':
      return { ...wc, hour: 0 };
    case 'week': {
      // ISO weeks start on Monday. getUTCDay() is 0=Sunday..6=Saturday, so
      // (d + 6) % 7 gives how many days we are past Monday.
      const key = dayKeyOf(wc);
      const [y, m, d] = key.split('-').map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return wallClockFromDayKey(shiftDayKey(key, -((weekday + 6) % 7)), 0);
    }
    case 'month':
      return { ...wc, day: 1, hour: 0 };
  }
}

/** The start of the bucket following `wc`. */
function advance(wc: WallClock, granularity: Granularity): WallClock {
  switch (granularity) {
    case 'hour':
      return wc.hour === 23
        ? wallClockFromDayKey(shiftDayKey(dayKeyOf(wc), 1), 0)
        : { ...wc, hour: wc.hour + 1 };
    case 'day':
      return wallClockFromDayKey(shiftDayKey(dayKeyOf(wc), 1), 0);
    case 'week':
      return wallClockFromDayKey(shiftDayKey(dayKeyOf(wc), 7), 0);
    case 'month':
      return wc.month === 12
        ? { year: wc.year + 1, month: 1, day: 1, hour: 0 }
        : { ...wc, month: wc.month + 1, day: 1, hour: 0 };
  }
}

/** Stable label for a bucket, in the caller's timezone. */
function keyOf(wc: WallClock, granularity: Granularity): string {
  const day = dayKeyOf(wc);
  switch (granularity) {
    case 'hour':
      return `${day}T${String(wc.hour).padStart(2, '0')}`;
    case 'day':
      return day;
    case 'week':
      // Labelled by the week's Monday, which `truncate` already resolved.
      return day;
    case 'month':
      return day.slice(0, 7);
  }
}

/**
 * Splits `[from, to)` into calendar buckets aligned to `tz`.
 *
 * Buckets follow the civil calendar of `tz` — not fixed millisecond strides —
 * so a DST day still yields one "day" bucket even though it lasts 23 or 25
 * hours. The first and last buckets are **clipped to the requested window**:
 * asking from 13:00 gives a first day-bucket covering only 13:00 to midnight,
 * which is what makes an arbitrary "7 Aug 13:00 → 18 Aug 03:00" range add up.
 *
 * Returns `[]` when the range is empty or inverted.
 */
export function bucketRange(
  from: Date,
  to: Date,
  granularity: Granularity,
  tz: string,
): Bucket[] {
  if (!(from < to)) return [];

  const buckets: Bucket[] = [];
  let cursor = truncate(wallClockIn(from, tz), granularity);

  while (buckets.length <= MAX_BUCKETS) {
    const start = instantFromWallClock(
      cursor.year,
      cursor.month,
      cursor.day,
      cursor.hour,
      tz,
    );
    const next = advance(cursor, granularity);
    const end = instantFromWallClock(
      next.year,
      next.month,
      next.day,
      next.hour,
      tz,
    );

    if (start >= to) break;

    // Clip to the requested window; the edges are normally partial buckets.
    const gte = start < from ? from : start;
    const lt = end > to ? to : end;
    if (gte < lt) buckets.push({ key: keyOf(cursor, granularity), gte, lt });

    // A DST fold can make `end` land on or before `start`; bail rather than spin.
    if (end <= start) break;
    cursor = next;
  }

  return buckets;
}

/** Whether this range/granularity pair would blow past `MAX_BUCKETS`. */
export function exceedsBucketLimit(
  from: Date,
  to: Date,
  granularity: Granularity,
): boolean {
  const span = to.getTime() - from.getTime();
  const approxWidth = {
    hour: 3_600_000,
    day: MS_PER_DAY,
    week: 7 * MS_PER_DAY,
    // Shortest month, so the estimate never undercounts.
    month: 28 * MS_PER_DAY,
  }[granularity];
  return span / approxWidth > MAX_BUCKETS;
}
