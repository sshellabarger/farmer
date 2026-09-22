/**
 * Market-local wall clock ↔ UTC with Intl only (no timezone dependency).
 *
 * SHARED VERBATIM: executor A1 owns this file; executor D copies it
 * byte-for-byte for the survey importer. Do not reformat or extend it here.
 *
 * Dates are 'YYYY-MM-DD' strings, times 'HH:mm' (24 h), zones IANA names.
 */

export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: DayOfWeek;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Parse 'YYYY-MM-DD'; throws on bad format or an impossible calendar date. */
export function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date '${date}': expected YYYY-MM-DD`);
  const parts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const probe = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (probe.getUTCFullYear() !== parts.y || probe.getUTCMonth() !== parts.m - 1 || probe.getUTCDate() !== parts.d) {
    throw new Error(`Invalid date '${date}': not a calendar date`);
  }
  return parts;
}

/** Parse 'HH:mm' (24 h); throws on bad format. */
export function parseTime(time: string): { hh: number; mm: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time '${time}': expected HH:mm`);
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Wall-clock parts of an instant in a zone. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'long',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24; // some engines print '24' at midnight
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: hour,
    mm: Number(get('minute')),
    ss: Number(get('second')),
    weekday: get('weekday').toLowerCase() as DayOfWeek,
  };
}

function wallMillis(w: WallClock): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
}

/**
 * The UTC instant at which `timeZone` shows `date` `time`.
 *
 * Iteration 1 treats the wall clock as if it were UTC, measures the zone's
 * offset at that guess and corrects by it. Iteration 2 repeats the
 * measurement at the corrected instant, which only differs when a DST
 * transition lies between the two. A wall-clock time inside a spring-forward
 * gap never round-trips; it resolves to the later instant (the clock has
 * already jumped). An ambiguous fall-back time resolves to its first
 * occurrence.
 */
export function localToUtc(date: string, time: string, timeZone: string): Date {
  const { y, m, d } = parseDate(date);
  const { hh, mm } = parseTime(time);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);

  const guessOffset = wallMillis(wallClock(new Date(target), timeZone)) - target;
  let candidate = target - guessOffset;

  const drift = wallMillis(wallClock(new Date(candidate), timeZone)) - target;
  if (drift !== 0) {
    const second = candidate - drift;
    if (wallMillis(wallClock(new Date(second), timeZone)) === target) candidate = second;
  }
  return new Date(candidate);
}

/** 'YYYY-MM-DD' of an instant in a zone. */
export function utcToLocalDate(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return formatDate(w.y, w.m, w.d);
}

/** 'HH:mm' of an instant in a zone. */
export function utcToLocalTime(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${pad2(w.hh)}:${pad2(w.mm)}`;
}

/** Calendar weekday of a 'YYYY-MM-DD' date (zone-independent). */
export function weekdayOf(date: string): DayOfWeek {
  const { y, m, d } = parseDate(date);
  return DAYS_OF_WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Add (or subtract) calendar days to a 'YYYY-MM-DD' date. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** Every date from `from` to `to` inclusive (empty when from > to). */
export function eachDate(from: string, to: string): string[] {
  parseDate(from);
  parseDate(to);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
