/**
 * Quiet-hours deferral (SPEC §6.5): an automated text whose instant falls
 * inside a market's quiet window is deferred to the window's end, computed
 * in the market's own timezone. Pure functions, no I/O.
 *
 * SHARED VERBATIM: executor B owns this file; executor A copies it
 * byte-for-byte. Do not reformat or extend it here.
 *
 * `quietHours` is the market's `{ start: 'HH:mm', end: 'HH:mm' }`. When
 * `end < start` the window wraps midnight (21:00 → 08:00); when
 * `end === start` there is no quiet window at all. The interval is half-open:
 * the start minute is quiet, the end minute is allowed.
 *
 * DST: the window end is resolved with `localToUtc`, so on the spring-forward
 * night an end time inside the 02:00–03:00 gap resolves to the later instant
 * and on the fall-back night an end time inside the repeated 01:00–02:00 hour
 * resolves to its first occurrence. A deferral that crosses a transition is
 * therefore one real hour shorter (spring) or longer (fall) than the wall
 * clock suggests, which is what "no texts before 08:00 local" means.
 */
import { addDays, localToUtc, parseTime, utcToLocalDate, wallClock } from './tz.js';

export interface QuietHours {
  start: string;
  end: string;
}

/** Minutes since local midnight of an 'HH:mm' time; throws on bad input. */
export function minutesOfDay(time: string): number {
  const { hh, mm } = parseTime(time);
  return hh * 60 + mm;
}

/** True when the instant's market-local wall clock is inside the quiet window. */
export function isQuiet(instant: Date, quietHours: QuietHours, timeZone: string): boolean {
  const s = minutesOfDay(quietHours.start);
  const e = minutesOfDay(quietHours.end);
  if (s === e) return false;
  const w = wallClock(instant, timeZone);
  const t = w.hh * 60 + w.mm;
  if (s < e) return t >= s && t < e;
  return t >= s || t < e;
}

/**
 * The first instant at or after `instant` that is outside the quiet window:
 * `instant` itself when it is not quiet, otherwise the window's end. A
 * wrapped window entered before midnight ends on the next local date; every
 * other case ends on the instant's own local date. Never returns an instant
 * earlier than the input.
 */
export function nextAllowedInstant(instant: Date, quietHours: QuietHours, timeZone: string): Date {
  if (!isQuiet(instant, quietHours, timeZone)) return instant;
  const s = minutesOfDay(quietHours.start);
  const e = minutesOfDay(quietHours.end);
  const w = wallClock(instant, timeZone);
  const t = w.hh * 60 + w.mm;
  const today = utcToLocalDate(instant, timeZone);
  const endDate = s > e && t >= s ? addDays(today, 1) : today;
  const end = localToUtc(endDate, quietHours.end, timeZone);
  return end.getTime() > instant.getTime() ? end : instant;
}
