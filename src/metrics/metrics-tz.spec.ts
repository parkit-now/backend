import {
  bucketRange,
  exceedsBucketLimit,
  DEFAULT_TIME_ZONE,
  dayKeyIn,
  dayRangeIn,
  partialDayRangeIn,
  shiftDayKey,
} from './metrics-tz';

/** Argentina sits at a fixed UTC-3 with no DST, so local midnight is 03:00Z. */
const AR = DEFAULT_TIME_ZONE;
/** New York exercises the DST paths Argentina never hits. */
const NY = 'America/New_York';

const HOURS = 3_600_000;

describe('metrics-tz', () => {
  describe('dayKeyIn', () => {
    it('resolves the civil day in the requested zone, not UTC', () => {
      // 02:00Z on the 28th is still the evening of the 27th in Argentina.
      const instant = new Date('2026-08-28T02:00:00.000Z');

      expect(dayKeyIn(instant, AR)).toBe('2026-08-27');
      expect(dayKeyIn(instant, 'UTC')).toBe('2026-08-28');
    });

    it('rolls over exactly at local midnight', () => {
      expect(dayKeyIn(new Date('2026-08-28T02:59:59.999Z'), AR)).toBe(
        '2026-08-27',
      );
      expect(dayKeyIn(new Date('2026-08-28T03:00:00.000Z'), AR)).toBe(
        '2026-08-28',
      );
    });
  });

  describe('dayRangeIn', () => {
    it('spans local midnight to local midnight', () => {
      const { gte, lt } = dayRangeIn('2026-08-27', AR);

      expect(gte.toISOString()).toBe('2026-08-27T03:00:00.000Z');
      expect(lt.toISOString()).toBe('2026-08-28T03:00:00.000Z');
    });

    it('is half-open so midnight is never counted in two days', () => {
      const today = dayRangeIn('2026-08-27', AR);
      const tomorrow = dayRangeIn('2026-08-28', AR);

      expect(today.lt.getTime()).toBe(tomorrow.gte.getTime());
    });

    it('produces a 23-hour day when DST springs forward', () => {
      // 2026-03-08 is the US spring-forward date: 02:00 jumps to 03:00.
      const { gte, lt } = dayRangeIn('2026-03-08', NY);

      expect(gte.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      expect(lt.getTime() - gte.getTime()).toBe(23 * HOURS);
    });

    it('produces a 25-hour day when DST falls back', () => {
      // 2026-11-01 is the US fall-back date: 02:00 repeats.
      const { gte, lt } = dayRangeIn('2026-11-01', NY);

      expect(gte.toISOString()).toBe('2026-11-01T04:00:00.000Z');
      expect(lt.getTime() - gte.getTime()).toBe(25 * HOURS);
    });

    it('rejects a malformed day key instead of silently drifting', () => {
      expect(() => dayRangeIn('27-08-2026', AR)).toThrow(/Invalid day key/);
    });
  });

  describe('shiftDayKey', () => {
    it('walks the calendar in both directions', () => {
      expect(shiftDayKey('2026-08-27', -1)).toBe('2026-08-26');
      expect(shiftDayKey('2026-08-27', -7)).toBe('2026-08-20');
      expect(shiftDayKey('2026-08-27', 1)).toBe('2026-08-28');
    });

    it('crosses month and year boundaries', () => {
      expect(shiftDayKey('2026-09-01', -1)).toBe('2026-08-31');
      expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('handles leap days', () => {
      expect(shiftDayKey('2028-03-01', -1)).toBe('2028-02-29');
      expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    });

    it('keeps the weekday aligned when stepping a full week back', () => {
      const day = new Date(`${shiftDayKey('2026-08-27', -7)}T12:00:00Z`);
      const reference = new Date('2026-08-27T12:00:00Z');

      expect(day.getUTCDay()).toBe(reference.getUTCDay());
    });

    it('survives a DST week without slipping a day', () => {
      // Pure calendar math, so a 23-hour day in the middle changes nothing.
      expect(shiftDayKey('2026-03-09', -7)).toBe('2026-03-02');
    });
  });

  describe('partialDayRangeIn', () => {
    it('truncates the day to the elapsed offset', () => {
      const { gte, lt } = partialDayRangeIn('2026-08-26', AR, 9 * HOURS);

      expect(gte.toISOString()).toBe('2026-08-26T03:00:00.000Z');
      expect(lt.toISOString()).toBe('2026-08-26T12:00:00.000Z');
    });

    it('collapses to an empty window at zero elapsed', () => {
      const { gte, lt } = partialDayRangeIn('2026-08-26', AR, 0);

      expect(gte.getTime()).toBe(lt.getTime());
    });

    it('clamps to the real end of a short DST day', () => {
      // 24h elapsed against a 23h day must not spill into the next day.
      const full = dayRangeIn('2026-03-08', NY);
      const partial = partialDayRangeIn('2026-03-08', NY, 24 * HOURS);

      expect(partial.lt.getTime()).toBe(full.lt.getTime());
    });
  });
});

describe('bucketRange', () => {
  const AR_TZ = AR;

  it('clips the first and last buckets to the requested window', () => {
    // The motivating example: 7 Aug 13:00 → 18 Aug 03:00, Argentine time.
    const from = new Date('2026-08-07T13:00:00-03:00');
    const to = new Date('2026-08-18T03:00:00-03:00');

    const buckets = bucketRange(from, to, 'day', AR_TZ);

    expect(buckets).toHaveLength(12);
    expect(buckets[0].key).toBe('2026-08-07');
    // First bucket starts at 13:00, not at midnight.
    expect(buckets[0].gte.getTime()).toBe(from.getTime());
    expect(buckets[0].lt.toISOString()).toBe('2026-08-08T03:00:00.000Z');
    // Last bucket stops at 03:00 local, not at the end of the day.
    expect(buckets[11].key).toBe('2026-08-18');
    expect(buckets[11].lt.getTime()).toBe(to.getTime());
  });

  it('leaves no gaps or overlaps between consecutive buckets', () => {
    const from = new Date('2026-08-07T13:00:00-03:00');
    const to = new Date('2026-08-18T03:00:00-03:00');

    const buckets = bucketRange(from, to, 'day', AR_TZ);

    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].gte.getTime()).toBe(buckets[i - 1].lt.getTime());
    }
  });

  it('aligns day buckets to local midnight, not UTC midnight', () => {
    const from = new Date('2026-08-07T00:00:00-03:00');
    const to = new Date('2026-08-09T00:00:00-03:00');

    const buckets = bucketRange(from, to, 'day', AR_TZ);

    expect(buckets.map((b) => b.key)).toEqual(['2026-08-07', '2026-08-08']);
    expect(buckets[0].gte.toISOString()).toBe('2026-08-07T03:00:00.000Z');
  });

  it('buckets by hour', () => {
    const from = new Date('2026-08-07T13:00:00-03:00');
    const to = new Date('2026-08-07T16:00:00-03:00');

    const buckets = bucketRange(from, to, 'hour', AR_TZ);

    expect(buckets.map((b) => b.key)).toEqual([
      '2026-08-07T13',
      '2026-08-07T14',
      '2026-08-07T15',
    ]);
  });

  it('labels week buckets by their Monday', () => {
    // 2026-08-07 is a Friday; its week starts Monday 2026-08-03.
    const from = new Date('2026-08-07T00:00:00-03:00');
    const to = new Date('2026-08-18T00:00:00-03:00');

    const buckets = bucketRange(from, to, 'week', AR_TZ);

    expect(buckets.map((b) => b.key)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
    // Clipped: the first week starts at `from`, not on the Monday itself.
    expect(buckets[0].gte.getTime()).toBe(from.getTime());
  });

  it('buckets by month across a year boundary', () => {
    const from = new Date('2026-11-15T00:00:00-03:00');
    const to = new Date('2027-02-01T00:00:00-03:00');

    const buckets = bucketRange(from, to, 'month', AR_TZ);

    expect(buckets.map((b) => b.key)).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });

  it('keeps a DST day as a single bucket', () => {
    // 2026-03-08 lasts 23 hours in New York; it is still one day bucket.
    const from = new Date('2026-03-08T00:00:00-05:00');
    const to = new Date('2026-03-09T00:00:00-04:00');

    const buckets = bucketRange(from, to, 'day', NY);

    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('2026-03-08');
    expect(buckets[0].lt.getTime() - buckets[0].gte.getTime()).toBe(23 * HOURS);
  });

  it('returns nothing for an empty or inverted range', () => {
    const t = new Date('2026-08-07T13:00:00-03:00');

    expect(bucketRange(t, t, 'day', AR_TZ)).toEqual([]);
    expect(bucketRange(t, new Date(t.getTime() - 1), 'day', AR_TZ)).toEqual([]);
  });
});

describe('exceedsBucketLimit', () => {
  it('flags an hourly range that would explode the payload', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2027-01-01T00:00:00Z');

    expect(exceedsBucketLimit(from, to, 'hour')).toBe(true);
    expect(exceedsBucketLimit(from, to, 'day')).toBe(false);
  });

  it('allows a reasonable hourly window', () => {
    const from = new Date('2026-08-01T00:00:00Z');
    const to = new Date('2026-08-08T00:00:00Z');

    expect(exceedsBucketLimit(from, to, 'hour')).toBe(false);
  });
});
