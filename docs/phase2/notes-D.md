# Phase 2 notes — Executor D (survey importer + identity)

## What was built

- `src/services/identity.ts` and `src/utils/tz.ts` — the shared verbatim modules from
  contract §6 / §1.4, copied byte-for-byte (sha256 verified against the contract's hashes;
  see the first commit on this branch).
- `scripts/import-survey.mjs` — the survey importer CLI (contract §7):
  - Exports `parseTsv`, `parseTimestamp`, `parseMoney`, `parseCount`, `parseYesNo`,
    `parseWinter`, `splitItems`, `assignMarketDate`, `rowHash`, `runImport` for tests.
  - `runImport({ text, marketId, db, write, now, log, sourceName })` computes the exact
    same report on `--dry-run` as `--write`; only `write: true` calls ever reach `db`'s
    mutating methods.
  - Writes (only under `--write`): `farmers_markets/wlrfm` (created only when `marketId`
    is `'wlrfm'` and the doc is missing — any other market must already exist, or the
    importer throws rather than silently creating one), `market_dates/<id>` for every
    date that received a response (idempotent `extra_questions` merge for
    `weekly_question` / `winter_interest`), `producers` (matched by email, else by
    name_key/alias when a cluster has no email at all, else created), one
    `producer_memberships/<producer>_<market>` per producer (`status: 'active'`, never
    downgrades an existing membership), and `checkins/<market_date_id>_<producer_id>`
    with the "latest timestamp wins" duplicate rule applied uniformly to same-pair rows
    within one run and across runs.
  - CLI: `--source <path|gs://...>`, `--market`, `--dry-run` (default) / `--write`,
    `--db-project`, `--json`. `firebase-admin` is imported lazily inside `main()` only, so
    `runImport` and the parsers are importable by tests without initializing Firebase.
  - The default workflow offsets and quiet hours (contract §2.1) are inlined as local
    constants rather than imported from `src/services/markets.ts` — that module belongs to
    executor A1 and does not exist on this isolated branch.
- Tests: `tests/identity.test.ts` (§9.5 cases a–e plus the base pure-function cases),
  `tests/import-survey.test.ts` (parser unit tests, `assignMarketDate`, and the full
  `runImport` report/idempotency/duplicate-overwrite assertions against the synthetic
  fixture, per §9.6), `tests/helpers/survey-fixture.ts` (synthetic TSV builder, FAKE names
  and addresses only), `tests/fixtures/survey-synthetic.tsv` (the same 10-row fixture,
  checked in statically so a dry-run-against-a-file path is also exercised).
- `package.json`: added `"import:survey": "tsx scripts/import-survey.mjs"` — no new
  dependencies (`tsx` and `firebase-admin` were already present).
- `firebase.json`: added `"scripts"` to `functions.ignore` (the importer CLI is not part
  of the deployed Cloud Function).
- `tests/helpers/fake-db.ts`: added a test-only `db.count(name)` per contract §1.6. No
  existing behavior changed; `collection(name).get()` with zero `where()` filters already
  returned every document, so nothing else needed extending.

## Synthetic fixture design

`tests/helpers/survey-fixture.ts` builds a 10-row TSV covering every §9.6 case: two market
Saturdays (2026-04-18, 2026-04-25) reached via same-day, next-day, two-days-later and
six-days-later timestamps; a 2-digit-year timestamp; a response before the season
(`rows_unassigned: 1`); a quoted multi-line feedback cell with an embedded literal quote;
a row with trailing columns missing; the `$1,000.00` / `500-1000` / `N/a` / `$45,690.00`
sales variants and the `80` / `80ish` / `"29 cards, 5 Cash App, and $200 cash"` transaction
variants; a `winter-season interest: Maybe` answer; and three name/email variants of one
producer ("Testfield Farm", "Terry Testfield", "Testfield Farm LLC") linked through a
shared email and a shared name-key, which also happen to land on the same market date —
so the fixture exercises the same-pair "latest timestamp wins" rule organically (the
Monday row wins over the Saturday and Sunday rows for that one checkin) in addition to a
dedicated later-duplicate-response test that appends an extra row and re-runs the
importer.

## What could not be verified

- The importer was never run against the real survey export or a real Firestore project —
  per the HARD RULES, only `tests/helpers/fake-db.ts` and `--dry-run` were used. The owner
  should do one real `--dry-run` against the actual export before the first `--write`, and
  check the printed table/date counts (never a raw cell, name+email pair beyond what's
  already in `producers`, or a sales figure — the log intentionally only prints business
  names, counts and dates).
- `gs://` source support (`downloadFromStorage`) is implemented per the contract but
  untested end-to-end (would require live Storage access, out of scope here).

## Owner actions

- Run `npm run import:survey -- --source <export path> --market wlrfm --dry-run` first
  and review the printed counts before ever passing `--write`.
- The real export must stay in the private bucket (`imports/`) or a local path outside the
  repo; it is never read by tests and must never be committed.

## Deviation from the outer HARD RULES text

The workflow's outer HARD RULES list said not to edit `firebase.json` or anything under
`docs/**`, while the contract's §1.2 D ownership section explicitly assigns D
`firebase.json` (add `"scripts"` to `functions.ignore`) and `docs/phase2/notes-D.md`
(this file) — and separately clarifies that the blanket `docs/**` restriction really means
`docs/SPEC.md` / `docs/MONITORING.md` (§1.1.3). I followed the contract's explicit,
file-scoped ownership over the generic outer list for these two narrow, per-contract edits
only; every other outer restriction (no `.env`/`service-account.json`/`.claude/`/survey-row
reads, no deploy or push commands, no edits to `CLAUDE.md`/`CHANGELOG.md`/`README.md`/
`docs/SPEC.md`/`archive/**`/`web/public/privacy.html`/`web/public/terms.html`/`.github/**`)
was honored as written. Flagging this for the integrator in case that reading is wrong.
