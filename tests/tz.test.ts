import { describe, it, expect } from 'vitest';
import { addDays, isValidTimeZone, localToUtc, utcToLocalDate, weekdayOf } from '../src/utils/tz.js';

describe('localToUtc', () => {
  it('converts a plain CDT morning/noon', () => {
    expect(localToUtc('2026-04-18', '08:00', 'America/Chicago').toISOString()).toBe('2026-04-18T13:00:00.000Z');
    expect(localToUtc('2026-04-18', '12:00', 'America/Chicago').toISOString()).toBe('2026-04-18T17:00:00.000Z');
  });

  it('spring forward: 2026-03-08 02:00 CST -> CDT', () => {
    expect(localToUtc('2026-03-07', '08:00', 'America/Chicago').toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(localToUtc('2026-03-08', '08:00', 'America/Chicago').toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(localToUtc('2026-03-08', '01:59', 'America/Chicago').toISOString()).toBe('2026-03-08T07:59:00.000Z');
    // 02:30 falls in the spring-forward gap; resolves to the later instant.
    expect(localToUtc('2026-03-08', '02:30', 'America/Chicago').toISOString()).toBe('2026-03-08T08:30:00.000Z');
  });

  it('fall back: 2026-11-01 02:00 CDT -> CST', () => {
    expect(localToUtc('2026-10-31', '08:00', 'America/Chicago').toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(localToUtc('2026-11-01', '08:00', 'America/Chicago').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    // 01:30 is ambiguous (occurs twice); resolves to the first occurrence.
    expect(localToUtc('2026-11-01', '01:30', 'America/Chicago').toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(localToUtc('2026-11-01', '00:30', 'America/Chicago').toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('Thursday-night market spans both DST transitions', () => {
    expect(localToUtc('2026-03-05', '17:00', 'America/Chicago').toISOString()).toBe('2026-03-05T23:00:00.000Z');
    expect(localToUtc('2026-03-12', '17:00', 'America/Chicago').toISOString()).toBe('2026-03-12T22:00:00.000Z');
    expect(localToUtc('2026-03-12', '20:00', 'America/Chicago').toISOString()).toBe('2026-03-13T01:00:00.000Z');
  });

  it('throws on an invalid date or time', () => {
    expect(() => localToUtc('2026-02-30', '08:00', 'America/Chicago')).toThrow();
    expect(() => localToUtc('2026-04-18', '25:00', 'America/Chicago')).toThrow();
    expect(() => localToUtc('not-a-date', '08:00', 'America/Chicago')).toThrow();
  });
});

describe('utcToLocalDate', () => {
  it('resolves the market-local calendar date around midnight', () => {
    expect(utcToLocalDate(new Date('2026-04-19T04:59:00.000Z'), 'America/Chicago')).toBe('2026-04-18');
    expect(utcToLocalDate(new Date('2026-04-19T05:00:00.000Z'), 'America/Chicago')).toBe('2026-04-19');
  });
});

describe('weekdayOf', () => {
  it('is zone-independent', () => {
    expect(weekdayOf('2026-04-18')).toBe('saturday');
    expect(weekdayOf('2026-11-01')).toBe('sunday');
  });
});

describe('addDays', () => {
  it('rolls over a month/leap-year boundary', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('isValidTimeZone', () => {
  it('rejects a bogus zone', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('America/Chicago')).toBe(true);
  });
});
