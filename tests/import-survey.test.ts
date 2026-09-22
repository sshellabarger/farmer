// Survey importer (Phase 2 contract §7, §9.6). Every row is synthetic — see
// tests/helpers/survey-fixture.ts and tests/fixtures/survey-synthetic.tsv.
// The real survey export is never read by a test.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseTsv,
  parseTimestamp,
  parseMoney,
  parseCount,
  parseYesNo,
  parseWinter,
  splitItems,
  assignMarketDate,
  rowHash,
  runImport,
} from '../scripts/import-survey.mjs';
import { fakeDb } from './helpers/fake-db.js';
import { buildSurveyTsv, buildSyntheticFixture, syntheticFixtureRows } from './helpers/survey-fixture.js';

const TZ = 'America/Chicago';

describe('parseTsv', () => {
  it('pads short records to 13 cells', () => {
    const records = parseTsv('a\tb\tc\n');
    expect(records[0]).toHaveLength(13);
    expect(records[0].slice(0, 3)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an embedded tab and newline inside a quoted field', () => {
    const text = 'h1\th2\n' + '"line one\nline two\twith a tab"\tsecond\n';
    const records = parseTsv(text);
    expect(records[1][0]).toBe('line one\nline two\twith a tab');
    expect(records[1][1]).toBe('second');
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    const records = parseTsv('h\n' + '"she said ""hi"""\n');
    expect(records[1][0]).toBe('she said "hi"');
  });

  it('handles a record with no trailing newline', () => {
    const records = parseTsv('a\tb\nc\td');
    expect(records).toHaveLength(2);
    expect(records[1].slice(0, 2)).toEqual(['c', 'd']);
  });
});

describe('parseTimestamp', () => {
  it('parses M/D/YYYY H:MM:SS', () => {
    const parsed = parseTimestamp('4/18/2026 8:30:15', TZ);
    expect(parsed?.local_date).toBe('2026-04-18');
    expect(parsed?.at.toISOString()).toBe('2026-04-18T13:30:15.000Z');
  });

  it('parses a bare M/D/YYYY as midnight', () => {
    const parsed = parseTimestamp('4/18/2026', TZ);
    expect(parsed?.local_date).toBe('2026-04-18');
    expect(parsed?.at.toISOString()).toBe('2026-04-18T05:00:00.000Z');
  });

  it('parses a 2-digit year as 2000+', () => {
    const parsed = parseTimestamp('4/18/26 8:00:00', TZ);
    expect(parsed?.local_date).toBe('2026-04-18');
  });

  it('returns null for unparseable or impossible text', () => {
    expect(parseTimestamp('not a date', TZ)).toBeNull();
    expect(parseTimestamp('13/40/2026', TZ)).toBeNull();
    expect(parseTimestamp('', TZ)).toBeNull();
  });
});

describe('parseMoney', () => {
  it('parses an exact figure, stripping $ and commas', () => {
    expect(parseMoney('$1,000.00')).toEqual({ value: 1000, kind: 'exact' });
    expect(parseMoney('$45,690.00')).toEqual({ value: 45690, kind: 'exact' });
  });

  it('parses a range as its midpoint', () => {
    expect(parseMoney('500-1000')).toEqual({ value: 750, kind: 'range' });
    expect(parseMoney('500 to 1000')).toEqual({ value: 750, kind: 'range' });
  });

  it('returns none for unparseable text', () => {
    expect(parseMoney('N/a')).toEqual({ value: null, kind: 'none' });
    expect(parseMoney('')).toEqual({ value: null, kind: 'none' });
  });
});

describe('parseCount', () => {
  it('takes the first integer', () => {
    expect(parseCount('80')).toEqual({ value: 80, ambiguous: false });
    expect(parseCount('80ish')).toEqual({ value: 80, ambiguous: false });
    expect(parseCount('about 30')).toEqual({ value: 30, ambiguous: false });
  });

  it('flags more than one integer as ambiguous but still returns the first', () => {
    expect(parseCount('29 cards, 5 Cash App, and $200 cash')).toEqual({ value: 29, ambiguous: true });
  });

  it('returns null with no integer present', () => {
    expect(parseCount('')).toEqual({ value: null, ambiguous: false });
    expect(parseCount('none')).toEqual({ value: null, ambiguous: false });
  });
});

describe('parseYesNo', () => {
  it('reads a leading yes/no', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('yes, definitely')).toBe(true);
    expect(parseYesNo('No')).toBe(false);
    expect(parseYesNo('n')).toBe(false);
  });

  it('returns null otherwise', () => {
    expect(parseYesNo('maybe')).toBeNull();
    expect(parseYesNo('')).toBeNull();
  });
});

describe('parseWinter', () => {
  it('reads a case-insensitive yes/maybe/no prefix', () => {
    expect(parseWinter('Maybe')).toBe('maybe');
    expect(parseWinter('yes please')).toBe('yes');
    expect(parseWinter('No thanks')).toBe('no');
  });

  it('returns null otherwise', () => {
    expect(parseWinter('')).toBeNull();
    expect(parseWinter('unsure')).toBeNull();
  });
});

describe('splitItems', () => {
  it('splits on commas, semicolons, newlines and "and"', () => {
    expect(splitItems('tomatoes, corn and squash; kale')).toEqual(['tomatoes', 'corn', 'squash', 'kale']);
  });

  it('treats a "none"-like whole answer as empty', () => {
    for (const v of ['no', 'None', 'nope', 'nothing', 'n/a', 'na', '-', 'No.']) {
      expect(splitItems(v)).toEqual([]);
    }
  });

  it('drops "none"-like cells from a mixed list', () => {
    expect(splitItems('tomatoes, none, corn')).toEqual(['tomatoes', 'corn']);
  });

  it('returns [] for blank input', () => {
    expect(splitItems('')).toEqual([]);
    expect(splitItems(undefined as unknown as string)).toEqual([]);
  });
});

describe('rowHash', () => {
  it('is stable for identical cells and differs when a cell changes', () => {
    const a = rowHash(['1', '2', '3']);
    const b = rowHash(['1', '2', '3']);
    const c = rowHash(['1', '2', '4']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

const WLRFM_SCHEDULE = {
  schedule: {
    versions: [
      {
        id: 'v1',
        effective_from: '2026-04-18',
        season_start: '2026-04-18',
        season_end: '2026-10-31',
        days_of_week: ['saturday'],
        start_time: '08:00',
        end_time: '12:00',
      },
    ],
  },
};

describe('assignMarketDate', () => {
  it('maps a same-day Saturday response to that Saturday', () => {
    expect(assignMarketDate('2026-04-18', WLRFM_SCHEDULE)).toBe('2026-04-18');
  });

  it('maps Sunday/Monday/Friday responses back to the preceding Saturday', () => {
    expect(assignMarketDate('2026-04-19', WLRFM_SCHEDULE)).toBe('2026-04-18');
    expect(assignMarketDate('2026-04-20', WLRFM_SCHEDULE)).toBe('2026-04-18');
    expect(assignMarketDate('2026-04-24', WLRFM_SCHEDULE)).toBe('2026-04-18');
  });

  it('returns null for a response before the season', () => {
    expect(assignMarketDate('2026-03-01', WLRFM_SCHEDULE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runImport, against the 10-row synthetic fixture (contract §9.6)

function buildFakeDb() {
  return fakeDb();
}

describe('runImport — synthetic fixture, first --write run', () => {
  it('produces the expected report', async () => {
    const db = buildFakeDb();
    const text = buildSyntheticFixture();
    const logLines: string[] = [];
    const report = await runImport({
      text,
      marketId: 'wlrfm',
      db,
      write: true,
      now: new Date('2026-05-01T00:00:00Z'),
      log: (line: string) => logLines.push(line),
      sourceName: 'survey-synthetic.tsv',
    });

    expect(report.rows_read).toBe(10);
    expect(report.rows_skipped_blank).toBe(0);
    expect(report.rows_bad_timestamp).toBe(0);
    expect(report.rows_unassigned).toBe(1);
    expect(report.dates_seen).toBe(2);
    expect(report.market_created).toBe(1);
    expect(report.market_dates_created).toBe(2);
    expect(report.market_dates_existing).toBe(0);

    expect(report.clusters).toBe(6);
    expect(report.clusters_unnamed).toBe(0);
    expect(report.producers_matched).toBe(0);
    expect(report.producers_created).toBe(6);
    expect(report.producers_updated).toBe(0);

    expect(report.memberships_created).toBe(6);
    expect(report.memberships_existing).toBe(0);

    expect(report.checkins_created).toBe(7);
    expect(report.checkins_updated).toBe(2);
    expect(report.checkins_unchanged).toBe(0);
    expect(report.checkins_duplicates_ignored).toBe(0);

    expect(report.flags.sales_outlier).toBe(1);
    expect(report.flags.transactions_ambiguous).toBe(1);
    expect(report.flags.duplicate_response).toBe(2);

    // No @ (email) and no $ (sales figure) ever reaches the log.
    const logged = logLines.join('\n');
    expect(logged).not.toContain('@');
    expect(logged).not.toContain('$');
  });

  it('creates the market with the §2.1 WLRFM shape', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const market = db.dump('farmers_markets').wlrfm as Record<string, unknown>;
    expect(market).toBeDefined();
    expect(market.name).toBe('West Little Rock Farmers Market');
    expect(market.slug).toBe('wlrfm');
    expect(market.timezone).toBe('America/Chicago');
    expect(market.active).toBe(true);
    expect(market.created_by).toBe('import');
    const schedule = market.schedule as { versions: Array<Record<string, unknown>> };
    expect(schedule.versions).toHaveLength(1);
    expect(schedule.versions[0].days_of_week).toEqual(['saturday']);
  });

  it('creates market_dates with correctly-resolved start_at/end_at and the right extra_questions', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const dates = db.dump('market_dates') as Record<string, Record<string, unknown>>;
    const apr18 = dates['wlrfm_2026-04-18'];
    const apr25 = dates['wlrfm_2026-04-25'];
    expect(apr18).toBeDefined();
    expect(apr25).toBeDefined();
    expect((apr18.start_at as Date).toISOString()).toBe('2026-04-18T13:00:00.000Z');
    expect(apr18.status).toBe('collecting');
    expect(apr18.source).toBe('import');

    const apr18Questions = (apr18.extra_questions as Array<{ key: string }>).map((q) => q.key);
    const apr25Questions = (apr25.extra_questions as Array<{ key: string }>).map((q) => q.key);
    expect(apr18Questions).toEqual(['weekly_question']);
    expect(apr25Questions).toEqual(['winter_interest']);
  });

  it('clusters the three Testfield variants into a single producer', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const producers = Object.values(db.dump('producers')) as Array<Record<string, unknown>>;
    const testfield = producers.find((p) => (p.emails as string[]).includes('hello@testfield.example'));
    expect(testfield).toBeDefined();
    expect(testfield!.business_name).toBe('Testfield Farm LLC');
    expect((testfield!.aliases as string[]).sort()).toEqual(['Terry Testfield', 'Testfield Farm']);
    expect((testfield!.emails as string[]).sort()).toEqual(['hello@testfield.example', 'terry@testfield.example']);
    expect(testfield!.source).toBe('import');
    expect(testfield!.phone).toBeNull();
    expect((testfield!.sms_consent as { status: string }).status).toBe('unknown');

    expect(producers).toHaveLength(6);
  });

  it('creates one active membership per producer at wlrfm', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const memberships = Object.entries(db.dump('producer_memberships')) as Array<[string, Record<string, unknown>]>;
    expect(memberships).toHaveLength(6);
    for (const [id, m] of memberships) {
      expect(id.endsWith('_wlrfm')).toBe(true);
      expect(m.status).toBe('active');
      expect(m.source).toBe('import');
      expect(m.history).toHaveLength(1);
    }
  });

  it('resolves the estimated-sales and transactions variants exactly', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const checkins = Object.values(db.dump('checkins')) as Array<Record<string, unknown>>;
    const byRawSales = (raw: string) => checkins.find((c) => (c.estimated_sales as { raw: string }).raw === raw);

    // The Testfield checkin for 2026-04-18 is the Monday (row 3, "N/a") row —
    // it won the same-pair overwrite over the earlier Saturday/Sunday rows,
    // so only its parsed values remain in the final document.
    const na = byRawSales('N/a');
    expect((na!.estimated_sales as { value: number | null; kind: string }).value).toBeNull();
    expect((na!.estimated_sales as { kind: string }).kind).toBe('none');

    const outlier = byRawSales('$45,690.00');
    expect((outlier!.flags as string[])).toContain('sales_outlier');

    const ambiguous = checkins.find((c) => (c.transactions_estimate as { raw: string }).raw.includes('Cash App'));
    expect((ambiguous!.transactions_estimate as { value: number }).value).toBe(29);
    expect((ambiguous!.flags as string[])).toContain('transactions_ambiguous');

    const winterRow = checkins.find((c) => (c.extra_answers as Record<string, unknown>).winter_interest !== undefined);
    expect((winterRow!.extra_answers as Record<string, unknown>).winter_interest).toBe('maybe');

    for (const c of checkins) {
      expect((c.raw_import as { cells: string[] }).cells).toHaveLength(13);
    }

    expect(checkins.find((c) => c.market_date_id === 'wlrfm_2026-04-18' && (c.raw_import as { row_hash: string }).row_hash)).toBeDefined();
  });

  it('gives the two same-pair Sunday/Monday responses to the Testfield producer, applying the latest wins inside one run', async () => {
    const db = buildFakeDb();
    await runImport({ text: buildSyntheticFixture(), marketId: 'wlrfm', db, write: true, now: new Date(), log: () => {} });
    const checkins = Object.entries(db.dump('checkins')) as Array<[string, Record<string, unknown>]>;
    const testfieldApr18 = checkins.find(([, c]) => c.market_date_id === 'wlrfm_2026-04-18');
    expect(testfieldApr18).toBeDefined();
    const [, doc] = testfieldApr18!;
    // The Monday (4/20) row is the latest of the three same-pair rows, so it wins.
    expect((doc.raw_import as { timestamp_raw: string }).timestamp_raw).toBe('4/20/2026 10:15:00');
    expect((doc.raw_import as { duplicates: number }).duplicates).toBe(2);
    expect((doc.flags as string[])).toContain('duplicate_response');
  });
});

describe('runImport — idempotency', () => {
  it('the second --write run creates and updates nothing new, and the db is unchanged (ignoring updated_at)', async () => {
    const db = buildFakeDb();
    const text = buildSyntheticFixture();
    await runImport({ text, marketId: 'wlrfm', db, write: true, now: new Date('2026-05-01T00:00:00Z'), log: () => {} });

    const stripUpdatedAt = (obj: Record<string, unknown>) => {
      const clone = JSON.parse(JSON.stringify(obj));
      const strip = (o: unknown): unknown => {
        if (Array.isArray(o)) return o.map(strip);
        if (o && typeof o === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (k === 'updated_at') continue;
            out[k] = strip(v);
          }
          return out;
        }
        return o;
      };
      return strip(clone);
    };

    const before = {
      farmers_markets: stripUpdatedAt(db.dump('farmers_markets')),
      market_dates: stripUpdatedAt(db.dump('market_dates')),
      producers: stripUpdatedAt(db.dump('producers')),
      producer_memberships: stripUpdatedAt(db.dump('producer_memberships')),
      checkins: stripUpdatedAt(db.dump('checkins')),
    };

    const report2 = await runImport({ text, marketId: 'wlrfm', db, write: true, now: new Date('2026-05-02T00:00:00Z'), log: () => {} });

    expect(report2.producers_created).toBe(0);
    expect(report2.producers_updated).toBe(0);
    expect(report2.market_dates_created).toBe(0);
    expect(report2.checkins_created).toBe(0);
    expect(report2.checkins_updated).toBe(0);
    expect(report2.market_created).toBe(0);

    const after = {
      farmers_markets: stripUpdatedAt(db.dump('farmers_markets')),
      market_dates: stripUpdatedAt(db.dump('market_dates')),
      producers: stripUpdatedAt(db.dump('producers')),
      producer_memberships: stripUpdatedAt(db.dump('producer_memberships')),
      checkins: stripUpdatedAt(db.dump('checkins')),
    };
    expect(after).toEqual(before);
  });
});

describe('runImport — a later duplicate response overwrites and increments duplicates', () => {
  it('a fresh, later response for an existing (producer, date) pair overwrites the checkin', async () => {
    const db = buildFakeDb();
    const text = buildSyntheticFixture();
    await runImport({ text, marketId: 'wlrfm', db, write: true, now: new Date('2026-05-01T00:00:00Z'), log: () => {} });

    const before = Object.entries(db.dump('checkins')).find(([, c]) => (c as Record<string, unknown>).market_date_id === 'wlrfm_2026-04-25' && ((c as Record<string, unknown>).raw_import as { cells: string[] }).cells[1] === 'Ridgeline Orchard');
    expect(before).toBeDefined();
    const beforeDuplicates = ((before![1] as Record<string, unknown>).raw_import as { duplicates: number }).duplicates;
    expect(beforeDuplicates).toBe(0);

    // A later response from the same producer for the same market date.
    const rows = syntheticFixtureRows();
    rows.push({
      timestamp: '4/25/2026 20:00:00',
      vendor_name: 'Ridgeline Orchard',
      email_address: 'ridgeline.orchard@gmail.com',
      sold_out: 'Peaches',
      attending_next_week: 'Yes',
      transactions: '60',
    });
    const text2 = buildSurveyTsv(rows);

    const report2 = await runImport({ text: text2, marketId: 'wlrfm', db, write: true, now: new Date('2026-05-03T00:00:00Z'), log: () => {} });
    expect(report2.checkins_updated).toBeGreaterThanOrEqual(1);
    expect(report2.flags.duplicate_response).toBeGreaterThanOrEqual(1);

    const after = Object.entries(db.dump('checkins')).find(([id]) => id === before![0]);
    expect(after).toBeDefined();
    const afterDoc = after![1] as Record<string, unknown>;
    expect((afterDoc.raw_import as { duplicates: number }).duplicates).toBe(1);
    expect((afterDoc.raw_import as { timestamp_raw: string }).timestamp_raw).toBe('4/25/2026 20:00:00');
    expect((afterDoc.flags as string[])).toContain('duplicate_response');
  });
});

describe('runImport — dry-run against the checked-in synthetic fixture', () => {
  it('computes the full report without writing anything to the db', async () => {
    const db = buildFakeDb();
    const text = readFileSync(new URL('./fixtures/survey-synthetic.tsv', import.meta.url), 'utf8');
    const logLines: string[] = [];
    const report = await runImport({
      text,
      marketId: 'wlrfm',
      db,
      write: false,
      now: new Date('2026-05-01T00:00:00Z'),
      log: (line: string) => logLines.push(line),
    });

    expect(report.market_created).toBe(1);
    expect(report.producers_created).toBe(6);
    expect(report.checkins_created).toBe(7);

    expect(db.dump('farmers_markets')).toEqual({});
    expect(db.dump('market_dates')).toEqual({});
    expect(db.dump('producers')).toEqual({});
    expect(db.dump('producer_memberships')).toEqual({});
    expect(db.dump('checkins')).toEqual({});

    const logged = logLines.join('\n');
    expect(logged).not.toContain('@');
    expect(logged).not.toContain('$');
  });
});

describe('runImport — a market other than wlrfm must already exist', () => {
  it('throws rather than silently creating an unknown market', async () => {
    const db = buildFakeDb();
    await expect(
      runImport({ text: buildSurveyTsv([]), marketId: 'argenta', db, write: true, now: new Date(), log: () => {} }),
    ).rejects.toThrow(/argenta/);
  });
});
