/**
 * SJCA works in Central time. Order days, delivery days and the payout week
 * are all counted in America/Chicago, whatever zone the server runs in.
 */
export const SJCA_TZ = 'America/Chicago';

function parts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: SJCA_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return p as Record<string, string>;
}

/** The Central-time calendar day of an instant, YYYY-MM-DD. */
export function centralDay(d: Date): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 0 = Sunday … 6 = Saturday, in Central time. */
export function centralWeekday(d: Date): number {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts(d).weekday);
}

/** The instant Central-time midnight starts on day YYYY-MM-DD (DST-aware). */
export function centralMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  // Central is UTC-5 or UTC-6: start from 06:00 UTC and correct by the observed hour.
  let t = Date.UTC(y, m - 1, d, 6);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t));
    const shownDay = `${p.year}-${p.month}-${p.day}`;
    const hours = Number(p.hour) + Number(p.minute) / 60;
    if (shownDay === day && hours === 0) break;
    t -= (shownDay === day ? hours : hours - 24) * 3600 * 1000;
  }
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * The payout week paid on a run: the Tuesday through Monday before the run's
 * Tuesday (Central). Run on any day, it picks the most recent Tuesday on or
 * before that day as the pay day.
 */
export function payoutWeek(run: Date): { payDay: string; startDay: string; endDay: string; start: Date; end: Date } {
  const today = centralDay(run);
  const back = (centralWeekday(run) - 2 + 7) % 7; // days since Tuesday
  const payDay = addDays(today, -back);
  const startDay = addDays(payDay, -7);
  const endDay = addDays(payDay, -1);
  return { payDay, startDay, endDay, start: centralMidnight(startDay), end: centralMidnight(payDay) };
}
