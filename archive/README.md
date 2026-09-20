# archive/

This folder preserves the pre-SJCA history of FarmLink, a text-first farm-to-buyer ordering platform piloted in Little Rock, AR (Mar–Jul 2026). `design-2026-03/` holds the original design package written for a Fastify + PostgreSQL + BullMQ/Redis stack that was replaced by Firebase Cloud Functions and Firestore on 2026-05-31 (commit `ee2ab6a`); the 14 entity names in the ERD survived as Firestore collection names. `postgres-era/` is that original code, recovered from git history — it is where the Postgres/BullMQ/Twilio description in later planning documents came from. `prototype/` is a click-through mock never wired to the API. `v1-web/` and `v1-ai-harness/` are the retired dashboards and the Claude tool-calling loop, kept as design reference. `reviews/` and `ops-log/` are the June 2026 interface review and the daily pilot triage log (its 'deploy still pending' entries from Jun 29 on were wrong — production was at HEAD). Do not reuse the buyer-facing 'market' concept described here: in the SJCA tool a market is a farmers-market event. The final v1 code is tagged `farmlink-v1-final`; branch `archive/farmlink-v1`.

Nothing in this folder is imported by the application, compiled by `tsc`, collected by
vitest (`vitest.config.ts`) or shipped in a functions deploy (`firebase.json →
functions.ignore`).

## Layout

| Folder | Contents |
|---|---|
| `design-2026-03/` | `README-original.md` (the old README, verbatim), `farmlink_architecture.md`, both SVG diagrams, the ERD HTML, `docker-compose.yml` |
| `prototype/` | `farmlink_v2.jsx` — single-file React click-through mock |
| `postgres-era/` | `migrations/001…006`, `database.ts`, `migrate.ts`, `seed.ts`, `workers/` (the real BullMQ code), `services/twilio.ts` — all `git show`n from `ee2ab6a^` / `e7b9431` |
| `v1-web/` | Retired dashboards and marketing components (added by the web-side retirement) |
| `v1-ai-harness/` | `conversation.ts`, `tools-index.ts`, `NOTES.md` (generic vs domain) |
| `v1-channels/` | Telnyx and WhatsApp senders/verifiers and their tests (decision D5) |
| `v1-web-links/` | `view-link.ts` — the texted `/api/view/<token>` pattern; reborn as `link_tokens` (SPEC §7.5) |
| `reviews/` | `interface-review-2026-06-12.md` |
| `ops-log/` | `triage-log-2026-06-07_to_2026-07-28.md` (redacted, with correction note), `MONITORING-2026-06.md` (snapshot before rewrite) |
| `firestore-schema-2026-09.md` | Generated during the Phase 1 data step (not yet present) |
