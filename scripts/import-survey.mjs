#!/usr/bin/env node
/**
 * Survey importer (SPEC §7.9, Phase 2 contract §7): seeds `farmers_markets`,
 * `market_dates`, `producers`, `producer_memberships` and `checkins` from a
 * Google Sheets export of the WLRFM weekly vendor survey.
 *
 * `--dry-run` (default) computes and prints the exact same report as
 * `--write` without touching Firestore. `firebase-admin` is imported lazily
 * inside `main()` only, so this module can be imported by tests (which call
 * `runImport` directly against `tests/helpers/fake-db.ts`) without ever
 * initializing Firebase.
 *
 * Never reads or prints the real survey TSV's rows outside a real run;
 * tests exercise this file only against synthetic, invented data.
 */

import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { resolveProducerIdentity, nameKey } from '../src/services/identity.ts';
import { localToUtc, weekdayOf, addDays } from '../src/utils/tz.ts';

// ---------------------------------------------------------------------------
// Constants (deliberately inlined, not imported from src/services/markets.ts:
// that module belongs to a different Phase 2 executor and does not exist on
// this branch).

const MARKET_TIMEZONE_DEFAULT = 'America/Chicago';

const DEFAULT_WORKFLOW = {
  checkin_offset_min: 60,
  reminder_offsets_min: [1440, 2880],
  deadline_offset_min: 4320,
  drafts_offset_min: 4380,
};

const DEFAULT_QUIET_HOURS = { start: '21:00', end: '08:00' };

const WEEKLY_QUESTION_KEY = 'weekly_question';
const WINTER_INTEREST_KEY = 'winter_interest';

const EMPTY_ITEM_RE = /^(no|none|nope|nothing|n\/?a|-|no\.)$/i;

// ---------------------------------------------------------------------------
// TSV parsing

/**
 * RFC-4180-ish tab-delimited parser (Google Sheets export): fields are
 * separated by `\t`; a field starting with `"` runs until the closing `"`
 * and may contain `\t`, `\n`, `\r\n`; `""` inside quotes is a literal quote;
 * records end at `\n`/`\r\n` outside quotes. Every record is padded with
 * `''` up to 13 cells (never truncated). Returns every record, including the
 * header row — callers decide what to skip.
 */
export function parseTsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    records.push(padRow(row));
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return records;
}

function padRow(row) {
  const cells = [...row];
  while (cells.length < 13) cells.push('');
  return cells;
}

// ---------------------------------------------------------------------------
// Field parsers

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

const TIMESTAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parses 'M/D/YYYY H:MM:SS', 'M/D/YYYY' or 'M/D/YY' in `timeZone`. */
export function parseTimestamp(raw, timeZone) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = TIMESTAMP_RE.exec(s);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000;
  const hh = m[4] !== undefined ? Number(m[4]) : 0;
  const mm = m[5] !== undefined ? Number(m[5]) : 0;
  const ss = m[6] !== undefined ? Number(m[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
  const timeStr = `${pad2(hh)}:${pad2(mm)}`;
  let at;
  try {
    at = localToUtc(dateStr, timeStr, timeZone);
  } catch {
    return null;
  }
  if (ss) at = new Date(at.getTime() + ss * 1000);
  return { at, local_date: dateStr };
}

/** `$1,000.00` → exact; `500-1000` / `500 to 1000` → range midpoint; else none. */
export function parseMoney(raw) {
  const s = (raw ?? '').trim();
  if (!s) return { value: null, kind: 'none' };
  const stripped = s.replace(/[$,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(stripped)) {
    return { value: Number(stripped), kind: 'exact' };
  }
  const range = /^(\d+(?:\.\d+)?)(?:-|–|to)+(\d+(?:\.\d+)?)$/i.exec(stripped);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return { value: (lo + hi) / 2, kind: 'range' };
  }
  return { value: null, kind: 'none' };
}

/** First integer in the text; more than one → `ambiguous: true`. */
export function parseCount(raw) {
  const matches = (raw ?? '').match(/\d+/g);
  if (!matches || matches.length === 0) return { value: null, ambiguous: false };
  return { value: Number(matches[0]), ambiguous: matches.length > 1 };
}

export function parseYesNo(raw) {
  const s = raw ?? '';
  if (/^\s*y(es)?\b/i.test(s)) return true;
  if (/^\s*no?\b/i.test(s)) return false;
  return null;
}

export function parseWinter(raw) {
  const s = (raw ?? '').trim().toLowerCase();
  if (/^yes/.test(s)) return 'yes';
  if (/^maybe/.test(s)) return 'maybe';
  if (/^no/.test(s)) return 'no';
  return null;
}

/** Splits a free-text list on `,`/`;`/newline/`and`; drops empties and "none"-like cells. */
export function splitItems(raw) {
  const s = (raw ?? '').trim();
  if (!s) return [];
  if (EMPTY_ITEM_RE.test(s)) return [];
  return s
    .split(/[,;\n]|\band\b/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !EMPTY_ITEM_RE.test(x));
}

export function rowHash(cells) {
  return createHash('sha256').update(cells.join('\t')).digest('hex');
}

// ---------------------------------------------------------------------------
// Market-date assignment

/**
 * The latest date <= `localDate` that is a market day for `market`
 * (weekday in the applicable schedule version's `days_of_week`, within that
 * version's season). `market` needs only `schedule.versions`. Returns null
 * when no market day is found back to the earliest season_start across all
 * versions (e.g. the response predates the market's first season).
 */
export function assignMarketDate(localDate, market) {
  const versions = market?.schedule?.versions ?? [];
  if (versions.length === 0) return null;
  const minStart = versions.reduce((min, v) => (v.season_start < min ? v.season_start : min), versions[0].season_start);

  let d = localDate;
  while (d >= minStart) {
    const applicable = findApplicableVersion(market, d);
    if (applicable && d >= applicable.season_start && d <= applicable.season_end && applicable.days_of_week.includes(weekdayOf(d))) {
      return d;
    }
    d = addDays(d, -1);
  }
  return null;
}

/** The last schedule version (by `effective_from` ascending) with `effective_from <= date`. */
function findApplicableVersion(market, date) {
  const versions = (market?.schedule?.versions ?? [])
    .filter((v) => v.effective_from <= date)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0));
  return versions[0] ?? null;
}

// ---------------------------------------------------------------------------
// The default WLRFM market (contract §2.1) — the only market the importer
// will create on its own; every other market must already exist.

function buildWlrfmMarket(now) {
  return {
    name: 'West Little Rock Farmers Market',
    slug: 'wlrfm',
    location: { name: 'Breckenridge Village', address: '' },
    timezone: MARKET_TIMEZONE_DEFAULT,
    schedule: {
      versions: [
        {
          id: uuid(),
          effective_from: '2026-04-18',
          season_start: '2026-04-18',
          season_end: '2026-10-31',
          days_of_week: ['saturday'],
          start_time: '08:00',
          end_time: '12:00',
          created_at: now,
          created_by: 'import',
        },
      ],
      skipped_dates: [],
      special_dates: [],
    },
    workflow: DEFAULT_WORKFLOW,
    quiet_hours: DEFAULT_QUIET_HOURS,
    active: true,
    created_by: 'import',
    created_at: now,
    updated_at: now,
  };
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (v && typeof v.toDate === 'function') return v.toDate();
  return new Date(v);
}

function sortedEqual(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// The importer

function emptyReport() {
  return {
    rows_read: 0,
    rows_skipped_blank: 0,
    rows_bad_timestamp: 0,
    rows_unassigned: 0,
    dates_seen: 0,
    market_created: 0,
    market_dates_created: 0,
    market_dates_existing: 0,
    clusters: 0,
    clusters_unnamed: 0,
    producers_matched: 0,
    producers_created: 0,
    producers_updated: 0,
    memberships_created: 0,
    memberships_existing: 0,
    checkins_created: 0,
    checkins_updated: 0,
    checkins_unchanged: 0,
    checkins_duplicates_ignored: 0,
    flags: { sales_outlier: 0, transactions_ambiguous: 0, duplicate_response: 0 },
    producers: [],
    dates: [],
  };
}

/**
 * Runs the importer against already-loaded TSV `text`. Never throws away
 * work on `write: false` — every counter reflects exactly what a `--write`
 * run would do. `db` is a Firestore-shaped client (`tests/helpers/fake-db.ts`
 * in tests, the real Firestore client from the CLI).
 */
export async function runImport({ text, marketId, db, write, now, log, sourceName }) {
  const nowDate = now ?? new Date();
  const emit = typeof log === 'function' ? log : () => {};
  const report = emptyReport();

  const records = parseTsv(text);
  const dataRecords = records.slice(1);

  // 1. Market
  const marketRef = db.collection('farmers_markets').doc(marketId);
  const marketSnap = await marketRef.get();
  let market;
  if (marketSnap.exists) {
    market = marketSnap.data();
  } else {
    if (marketId !== 'wlrfm') {
      throw new Error(`Market '${marketId}' does not exist; the importer can only auto-create 'wlrfm'`);
    }
    market = buildWlrfmMarket(nowDate);
    report.market_created = 1;
    if (write) await marketRef.set(market);
  }

  // 2. Parse rows
  const parsedRows = [];
  for (const cells of dataRecords) {
    if (cells.every((c) => c.trim() === '')) {
      report.rows_skipped_blank += 1;
      continue;
    }
    report.rows_read += 1;

    const timestampRaw = cells[0] ?? '';
    const parsedTs = parseTimestamp(timestampRaw, market.timezone);
    if (!parsedTs) {
      report.rows_bad_timestamp += 1;
      continue;
    }
    const marketDate = assignMarketDate(parsedTs.local_date, market);
    if (!marketDate) {
      report.rows_unassigned += 1;
      continue;
    }

    const sales = parseMoney(cells[3]);
    const salesOutlier = sales.value !== null && sales.value > 20000;
    const tx = parseCount(cells[9]);
    const winter = parseWinter(cells[12]);

    if (salesOutlier) report.flags.sales_outlier += 1;
    if (tx.ambiguous) report.flags.transactions_ambiguous += 1;

    parsedRows.push({
      cells,
      name: cells[1] ?? '',
      emails: [cells[2], cells[11]],
      at: parsedTs.at,
      timestampRaw,
      marketDate,
      estimated_sales: { value: sales.value, raw: cells[3] ?? '', kind: sales.kind },
      transactions_estimate: { value: tx.value, raw: cells[9] ?? '' },
      sold_out_items: splitItems(cells[4]),
      sold_out_raw: cells[4] ?? '',
      unsold_items: splitItems(cells[10]),
      unsold_raw: cells[10] ?? '',
      attending_next: parseYesNo(cells[5]),
      attending_next_raw: cells[5] ?? '',
      bringing_next_raw: cells[6] ?? '',
      feedback: cells[7] ?? '',
      weekly_question: cells[8] ?? '',
      winter_interest: winter,
      base_flags: [...(salesOutlier ? ['sales_outlier'] : []), ...(tx.ambiguous ? ['transactions_ambiguous'] : [])],
    });
  }

  const dateCounts = new Map();
  for (const row of parsedRows) dateCounts.set(row.marketDate, (dateCounts.get(row.marketDate) ?? 0) + 1);
  report.dates_seen = dateCounts.size;
  report.dates = [...dateCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, responses]) => ({ date, responses }));

  // 3. market_dates (needs the rows' weekly/winter answers to size extra_questions)
  for (const date of [...dateCounts.keys()].sort()) {
    const dateId = `${marketId}_${date}`;
    const dateRef = db.collection('market_dates').doc(dateId);
    const dateSnap = await dateRef.get();
    const version = findApplicableVersion(market, date);
    const rowsForDate = parsedRows.filter((r) => r.marketDate === date);
    const hasWeekly = rowsForDate.some((r) => r.weekly_question.trim() !== '');
    const hasWinter = rowsForDate.some((r) => r.winter_interest !== null);

    if (!dateSnap.exists) {
      const startAt = localToUtc(date, version.start_time, market.timezone);
      const endAt = localToUtc(date, version.end_time, market.timezone);
      const deadlineAt = new Date(endAt.getTime() + market.workflow.deadline_offset_min * 60_000);
      const extraQuestions = [];
      if (hasWeekly) {
        extraQuestions.push({ key: WEEKLY_QUESTION_KEY, prompt: 'Weekly question (prompt not present in the export)', type: 'text' });
      }
      if (hasWinter) {
        extraQuestions.push({
          key: WINTER_INTEREST_KEY,
          prompt: 'Are you interested in a winter season?',
          type: 'choice',
          options: ['yes', 'maybe', 'no'],
        });
      }
      const doc = {
        market_id: marketId,
        date,
        start_time: version.start_time,
        end_time: version.end_time,
        start_at: startAt,
        end_at: endAt,
        status: 'collecting',
        schedule_version: version.id,
        special: false,
        note: '',
        actions: {
          checkin_sent_at: null,
          reminders_sent: [],
          deadline_at: deadlineAt,
          deadline_processed_at: null,
          drafts_generated_at: null,
          approved_at: null,
          booth_texts_sent_at: null,
        },
        extra_questions: extraQuestions,
        sponsor_id: null,
        cancellation_reason: null,
        cancelled_at: null,
        cancelled_by: null,
        generated_at: nowDate,
        source: 'import',
        created_at: nowDate,
        updated_at: nowDate,
      };
      report.market_dates_created += 1;
      if (write) await dateRef.set(doc);
    } else {
      report.market_dates_existing += 1;
      const existing = dateSnap.data();
      const existingQs = existing.extra_questions ?? [];
      const existingKeys = new Set(existingQs.map((q) => q.key));
      const toAdd = [];
      if (hasWeekly && !existingKeys.has(WEEKLY_QUESTION_KEY)) {
        toAdd.push({ key: WEEKLY_QUESTION_KEY, prompt: 'Weekly question (prompt not present in the export)', type: 'text' });
      }
      if (hasWinter && !existingKeys.has(WINTER_INTEREST_KEY)) {
        toAdd.push({
          key: WINTER_INTEREST_KEY,
          prompt: 'Are you interested in a winter season?',
          type: 'choice',
          options: ['yes', 'maybe', 'no'],
        });
      }
      if (toAdd.length > 0 && write) {
        await dateRef.update({ extra_questions: [...existingQs, ...toAdd], updated_at: nowDate });
      }
    }
  }

  // 4. Identity clustering + producers + memberships
  const identityRows = parsedRows.map((r) => ({ name: r.name, emails: r.emails }));
  const clusters = resolveProducerIdentity(identityRows);
  report.clusters = clusters.length;

  const existingProducersSnap = await db.collection('producers').get();
  const producersById = new Map(existingProducersSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const byEmail = new Map();
  for (const p of producersById.values()) {
    for (const e of p.emails ?? []) byEmail.set(e, p);
  }

  const rowToProducerId = new Map();

  for (const cluster of clusters) {
    if (!cluster.canonical_name) {
      report.clusters_unnamed += 1;
      continue;
    }

    let matched = null;
    for (const e of cluster.emails) {
      if (byEmail.has(e)) {
        matched = byEmail.get(e);
        break;
      }
    }
    if (!matched && cluster.emails.length === 0) {
      const key = nameKey(cluster.canonical_name);
      matched =
        [...producersById.values()].find((p) => p.name_key === key || (p.aliases ?? []).includes(cluster.canonical_name)) ?? null;
    }

    let producerId;
    let producerEmails;
    let producerAliases;

    if (matched) {
      report.producers_matched += 1;
      producerId = matched.id;
      const mergedEmails = Array.from(new Set([...(matched.emails ?? []), ...cluster.emails]));
      const mergedAliases = Array.from(
        new Set([...(matched.aliases ?? []), ...cluster.aliases, cluster.canonical_name].filter((a) => a !== matched.business_name)),
      );
      const changed = !sortedEqual(mergedEmails, matched.emails ?? []) || !sortedEqual(mergedAliases, matched.aliases ?? []);
      if (changed) {
        report.producers_updated += 1;
        if (write) {
          await db.collection('producers').doc(producerId).set({ emails: mergedEmails, aliases: mergedAliases, updated_at: nowDate }, { merge: true });
        }
      }
      producerEmails = mergedEmails;
      producerAliases = mergedAliases;
      producersById.set(producerId, { ...matched, emails: mergedEmails, aliases: mergedAliases });
    } else {
      producerId = uuid();
      producerEmails = cluster.emails;
      producerAliases = cluster.aliases;
      const producerDoc = {
        business_name: cluster.canonical_name,
        name_key: nameKey(cluster.canonical_name),
        contact_name: '',
        phone: null,
        email: cluster.emails[0] ?? null,
        emails: cluster.emails,
        aliases: cluster.aliases,
        products: [],
        category: '',
        documents: [],
        sms_consent: { status: 'unknown', at: null, source: 'import' },
        sms_opt_out_at: null,
        user_id: null,
        legacy_farm_id: null,
        notes: '',
        source: 'import',
        active: true,
        created_at: nowDate,
        updated_at: nowDate,
      };
      report.producers_created += 1;
      if (write) await db.collection('producers').doc(producerId).set(producerDoc);
      producersById.set(producerId, { id: producerId, ...producerDoc });
    }

    for (const e of producerEmails) byEmail.set(e, producersById.get(producerId));

    report.producers.push({
      business_name: cluster.canonical_name,
      rows: cluster.rows.length,
      aliases: producerAliases.length,
      emails: producerEmails.length,
    });

    for (const rowIdx of cluster.rows) rowToProducerId.set(rowIdx, producerId);

    // Membership
    const membershipId = `${producerId}_${marketId}`;
    const membershipRef = db.collection('producer_memberships').doc(membershipId);
    const membershipSnap = await membershipRef.get();
    if (!membershipSnap.exists) {
      report.memberships_created += 1;
      if (write) {
        await membershipRef.set({
          producer_id: producerId,
          market_id: marketId,
          status: 'active',
          usual_booth_id: null,
          fee_plan: 'weekly',
          approved_at: null,
          approved_by: null,
          history: [{ from: null, to: 'active', at: nowDate, by: 'import', note: null }],
          source: 'import',
          created_at: nowDate,
          updated_at: nowDate,
        });
      }
      // Never downgrades an existing (e.g. inactive) membership — an existing
      // doc is left alone, whichever status it holds.
    } else {
      report.memberships_existing += 1;
    }
  }

  // 5. Check-ins
  const checkinsCache = new Map();
  const getCheckinState = async (id) => {
    if (checkinsCache.has(id)) return checkinsCache.get(id);
    const snap = await db.collection('checkins').doc(id).get();
    const state = snap.exists ? snap.data() : null;
    checkinsCache.set(id, state);
    return state;
  };

  const importSource = sourceName ?? 'import';

  for (let i = 0; i < parsedRows.length; i += 1) {
    const row = parsedRows[i];
    const producerId = rowToProducerId.get(i);
    if (!producerId) continue; // row belonged to an unnamed (skipped) cluster

    const marketDateId = `${marketId}_${row.marketDate}`;
    const checkinId = `${marketDateId}_${producerId}`;
    const hash = rowHash(row.cells);
    const flags = [...row.base_flags];

    const buildDoc = (createdAt, duplicates, extraFlags) => ({
      producer_id: producerId,
      market_id: marketId,
      market_date_id: marketDateId,
      submitted_at: row.at,
      source: 'import',
      token_id: null,
      estimated_sales: row.estimated_sales,
      transactions_estimate: row.transactions_estimate,
      sold_out_items: row.sold_out_items,
      sold_out_raw: row.sold_out_raw,
      unsold_items: row.unsold_items,
      unsold_raw: row.unsold_raw,
      attending_next: row.attending_next,
      attending_next_raw: row.attending_next_raw,
      bringing_next: [],
      bringing_next_raw: row.bringing_next_raw,
      feedback: row.feedback,
      extra_answers: {
        ...(row.weekly_question.trim() !== '' ? { weekly_question: row.weekly_question } : {}),
        ...(row.winter_interest !== null ? { winter_interest: row.winter_interest } : {}),
      },
      flags: [...flags, ...extraFlags],
      raw_import: { row_hash: hash, source: importSource, cells: row.cells, timestamp_raw: row.timestampRaw, duplicates },
      created_at: createdAt,
      updated_at: nowDate,
    });

    const existing = await getCheckinState(checkinId);
    if (!existing) {
      const doc = buildDoc(nowDate, 0, []);
      report.checkins_created += 1;
      checkinsCache.set(checkinId, doc);
      if (write) await db.collection('checkins').doc(checkinId).set(doc);
    } else if (existing.raw_import && existing.raw_import.row_hash === hash) {
      report.checkins_unchanged += 1;
    } else {
      const existingAt = toDate(existing.submitted_at);
      if (row.at.getTime() > existingAt.getTime()) {
        const duplicates = (existing.raw_import?.duplicates ?? 0) + 1;
        const doc = buildDoc(existing.created_at ?? nowDate, duplicates, ['duplicate_response']);
        report.checkins_updated += 1;
        report.flags.duplicate_response += 1;
        checkinsCache.set(checkinId, doc);
        if (write) await db.collection('checkins').doc(checkinId).set(doc);
      } else {
        report.checkins_duplicates_ignored += 1;
      }
    }
  }

  emitReport(report, emit);
  return report;
}

function emitReport(report, log) {
  log(
    `rows_read=${report.rows_read} rows_skipped_blank=${report.rows_skipped_blank} rows_bad_timestamp=${report.rows_bad_timestamp} rows_unassigned=${report.rows_unassigned}`,
  );
  log(
    `dates_seen=${report.dates_seen} market_created=${report.market_created} market_dates_created=${report.market_dates_created} market_dates_existing=${report.market_dates_existing}`,
  );
  log(
    `clusters=${report.clusters} clusters_unnamed=${report.clusters_unnamed} producers_matched=${report.producers_matched} producers_created=${report.producers_created} producers_updated=${report.producers_updated}`,
  );
  log(`memberships_created=${report.memberships_created} memberships_existing=${report.memberships_existing}`);
  log(
    `checkins_created=${report.checkins_created} checkins_updated=${report.checkins_updated} checkins_unchanged=${report.checkins_unchanged} checkins_duplicates_ignored=${report.checkins_duplicates_ignored}`,
  );
  log(
    `flags: sales_outlier=${report.flags.sales_outlier} transactions_ambiguous=${report.flags.transactions_ambiguous} duplicate_response=${report.flags.duplicate_response}`,
  );
  log('producers (business name / rows / aliases / emails):');
  for (const p of report.producers) {
    log(`  ${p.business_name} / ${p.rows} / ${p.aliases} / ${p.emails}`);
  }
  log('dates (date / responses):');
  for (const d of report.dates) {
    log(`  ${d.date} / ${d.responses}`);
  }
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { dryRun: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--source':
        args.source = argv[(i += 1)];
        break;
      case '--market':
        args.market = argv[(i += 1)];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--write':
        args.dryRun = false;
        break;
      case '--db-project':
        args.dbProject = argv[(i += 1)];
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.source) throw new Error('--source is required');
  if (!args.market) throw new Error('--market is required');
  return args;
}

async function downloadFromStorage(gsUrl) {
  const { getStorage } = await import('firebase-admin/storage');
  const withoutScheme = gsUrl.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) throw new Error(`Invalid gs:// url: ${gsUrl}`);
  const bucketName = withoutScheme.slice(0, slash);
  const objectName = withoutScheme.slice(slash + 1);
  const dest = path.join(tmpdir(), `import-survey-${Date.now()}-${path.basename(objectName)}`);
  await getStorage().bucket(bucketName).file(objectName).download({ destination: dest });
  return dest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    initializeApp(args.dbProject ? { projectId: args.dbProject } : undefined);
  }
  const db = getFirestore();

  const fromStorage = args.source.startsWith('gs://');
  const localPath = fromStorage ? await downloadFromStorage(args.source) : args.source;

  try {
    const text = await readFile(localPath, 'utf8');
    const report = await runImport({
      text,
      marketId: args.market,
      db,
      write: !args.dryRun,
      now: new Date(),
      log: (line) => console.log(line),
      sourceName: path.basename(args.source),
    });
    if (args.json) {
      console.log(JSON.stringify(report));
    }
    if (args.dryRun) {
      console.log('(dry run — no writes made; pass --write to persist)');
    }
  } finally {
    if (fromStorage) await unlink(localPath).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
