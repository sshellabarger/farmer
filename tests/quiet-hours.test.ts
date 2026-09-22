// Phase 3 contract §7.2. Pure-function tests against the shared, verbatim
// src/utils/quiet-hours.ts (contract §1.4) — no I/O, no fake-db needed.
import { describe, it, expect } from 'vitest';
import { isQuiet, minutesOfDay, nextAllowedInstant } from '../src/utils/quiet-hours.js';

const TZ = 'America/Chicago';
const WRAP = { start: '21:00', end: '08:00' };

describe('minutesOfDay', () => {
  it('converts HH:mm to minutes since midnight', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('08:00')).toBe(480);
    expect(minutesOfDay('21:00')).toBe(1260);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  it('throws on a bad time', () => {
    expect(() => minutesOfDay('25:00')).toThrow();
  });
});

describe('isQuiet — wrapped window 21:00–08:00 America/Chicago', () => {
  // 2026-09-17 is CDT (UTC-5): local HH:mm -> instant is local + 5h.
  const local = (hhmm: string) => new Date(`2026-09-17T${hhmm}:00-05:00`);

  it('20:59 is not quiet', () => {
    expect(isQuiet(local('20:59'), WRAP, TZ)).toBe(false);
  });

  it('21:00 (the start minute) is quiet', () => {
    expect(isQuiet(local('21:00'), WRAP, TZ)).toBe(true);
  });

  it('00:30 is quiet', () => {
    expect(isQuiet(local('00:30'), WRAP, TZ)).toBe(true);
  });

  it('07:59 is quiet', () => {
    expect(isQuiet(local('07:59'), WRAP, TZ)).toBe(true);
  });

  it('08:00 (the end minute) is not quiet — half-open interval', () => {
    expect(isQuiet(local('08:00'), WRAP, TZ)).toBe(false);
  });
});

describe('nextAllowedInstant — wrapped window, America/Chicago', () => {
  it('22:40 local (entering quiet before midnight) defers to 08:00 the next local date', () => {
    const instant = new Date('2026-09-18T03:40:00Z'); // 2026-09-17 22:40 CDT
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result.toISOString()).toBe('2026-09-18T13:00:00.000Z');
  });

  it('00:30 local (already past midnight, inside quiet) defers to 08:00 the same local date', () => {
    const instant = new Date('2026-09-18T05:30:00Z'); // 2026-09-18 00:30 CDT
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result.toISOString()).toBe('2026-09-18T13:00:00.000Z');
  });

  it('returns the identical Date instance when the instant is already allowed', () => {
    const instant = new Date('2026-09-18T14:00:00Z'); // mid-afternoon, not quiet
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result).toBe(instant);
  });
});

describe('nextAllowedInstant — DST transitions, America/Chicago', () => {
  it('spring-forward week: 22:40 CST the night before defers ~8h20m real to 08:00 CDT', () => {
    const instant = new Date('2026-03-08T04:40:00Z'); // 2026-03-07 22:40 CST
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(result.getTime() - instant.getTime()).toBe(8 * 60 * 60_000 + 20 * 60_000);
  });

  it('spring-forward day: 01:30 CST (before the 2am jump) defers to 08:00 CDT the same date', () => {
    const instant = new Date('2026-03-08T07:30:00Z'); // 2026-03-08 01:30 CST
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('fall-back week: 22:40 CDT the night before defers ~10h20m real to 08:00 CST', () => {
    const instant = new Date('2026-11-01T03:40:00Z'); // 2026-10-31 22:40 CDT
    const result = nextAllowedInstant(instant, WRAP, TZ);
    expect(result.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(result.getTime() - instant.getTime()).toBe(10 * 60 * 60_000 + 20 * 60_000);
  });
});

describe('isQuiet / nextAllowedInstant — same-day window (no wrap)', () => {
  const SAME_DAY = { start: '12:00', end: '14:00' };

  it('12:30 is quiet and defers to 14:00 the same local date', () => {
    const instant = new Date('2026-06-10T17:30:00Z'); // 12:30 CDT
    expect(isQuiet(instant, SAME_DAY, TZ)).toBe(true);
    const result = nextAllowedInstant(instant, SAME_DAY, TZ);
    expect(result.toISOString()).toBe('2026-06-10T19:00:00.000Z'); // 14:00 CDT
  });

  it('14:00 (the end minute) is allowed', () => {
    const instant = new Date('2026-06-10T19:00:00Z'); // 14:00 CDT
    expect(isQuiet(instant, SAME_DAY, TZ)).toBe(false);
    expect(nextAllowedInstant(instant, SAME_DAY, TZ)).toBe(instant);
  });
});

describe('isQuiet — empty window (start === end)', () => {
  it('is never quiet', () => {
    const EMPTY = { start: '08:00', end: '08:00' };
    expect(isQuiet(new Date('2026-06-10T00:00:00Z'), EMPTY, TZ)).toBe(false);
    expect(isQuiet(new Date('2026-06-10T12:00:00Z'), EMPTY, TZ)).toBe(false);
    expect(isQuiet(new Date('2026-06-10T13:00:00Z'), EMPTY, TZ)).toBe(false); // 08:00 local CDT
  });
});

describe('a different market timezone (America/New_York)', () => {
  it('defers 22:40 local to the next 08:00 in that zone', () => {
    const instant = new Date('2026-09-16T02:40:00Z'); // 2026-09-15 22:40 EDT
    const result = nextAllowedInstant(instant, WRAP, 'America/New_York');
    // 2026-09-16 08:00 America/New_York (EDT, UTC-4) = 2026-09-16T12:00:00Z.
    expect(result.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });
});

describe('bad input', () => {
  it('throws on an invalid time string', () => {
    expect(() => isQuiet(new Date(), { start: '25:00', end: '08:00' }, TZ)).toThrow();
  });
});
