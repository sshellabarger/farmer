# Changelog

All notable changes to this project. Format follows Keep a Changelog; dates are
America/Chicago.

## [Unreleased] — SJCA rework, Step 1 (2026-09-20)

### Added
- `CLAUDE.md` — conventions, commands and ground rules for the rework.
- `docs/SPEC.md` — full SJCA market-management spec, refined by a repo audit; includes
  the archive plan, Firestore/Storage migration plan, security findings and the list of
  open decisions awaiting owner approval.
- This changelog.

### Audit findings recorded (no code changed)
- The stack described in `README.md` (Postgres/Kysely/BullMQ/Twilio) was retired on
  2026-05-31 (`ee2ab6a`); production is Firebase Cloud Functions + Firestore + voip.ms.
- Production is deployed at HEAD (`8c4cfea`, 2026-07-06). The triage log's "deploy still
  pending" entries from Jun 29–Jul 28 were never verified and are wrong.
- Real pilot data exists in Firestore and Storage; the owner's stop-before-dropping rule
  applies. Firestore has no PITR, no backups and no delete protection.
- Three Cloud Scheduler jobs are live and firing daily; `freshnessAlerts` is timing out
  (504) yet still texting one producer every morning.
- Every functions deploy has packaged `.env`, `service-account.json` (Owner-role key) and
  `.claude/settings.local.json` (containing API keys) into the GCF source bucket.
- The live voip.ms inbound webhook is unauthenticated; the WhatsApp route accepts
  unsigned payloads; the Cloud Tasks queue has never executed.

### Not yet done (Phase 1, pending approval)
- Tag `farmlink-v1-final`, branch `archive/farmlink-v1`, create `archive/`, export and
  delete retired collections, remove retired functions and code.
