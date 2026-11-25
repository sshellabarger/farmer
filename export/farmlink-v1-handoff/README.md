# FarmLink v1 — handoff package (start here)

Prepared 2026-11-25 to move FarmLink v1 to the SJCA Claude account and rebuild it with
**Square** as the system of record. A Claude session in the new account has none of the
old account's memory or chat history. **This folder is the whole briefing.** Paste the
"Brief for the new Claude session" block below into the first message, then point the
session at the files listed under it.

No production data, phone numbers, personal names or secrets are in this package.

## Brief for the new Claude session

> FarmLink v1 is a text-first farm-to-buyer ordering platform for Little Rock, AR,
> piloted March–July 2026. Farmers text their harvest ("20 lb Cherokee Purple tomatoes,
> $4/lb, picked today"). An AI assistant (Claude with tool calling) turns those texts into
> inventory, notifies connected buyers ("markets": restaurants, grocers, food banks,
> co-ops, schools) in priority order, and takes their orders by text. Orders flow through
> one central depot: the farmer drops off, the buyer picks up. A Next.js web app gives
> farmers, buyers and an admin dashboards, OTP login, settings, feedback and broadcasts.
>
> The v1 code is Node 22 / TypeScript / Fastify inside Firebase Cloud Functions, with
> Firestore, voip.ms SMS, Resend email and the Anthropic SDK. It lives in the GitHub repo
> `sshellabarger/farmer` at tag `farmlink-v1-final` (branch `revert/farmlink-v1` has the
> same tree plus this folder).
>
> Goal: rebuild FarmLink so that **Square** holds the catalog, inventory, buyers,
> vendors (farms), orders and payments, and a small app database keeps only what Square
> can't hold (texting, login, farm–buyer connections, schedules, reminders). Read
> `04-square-mapping.md` first, then `01-product.md` and `03-data-model.md`.
> `05-known-issues.md` lists what v1 got wrong; don't repeat those mistakes.
>
> Ground rules: development must never send real texts or emails (v1 had no guard; build
> one first). Secrets only in environment variables, never in a deploy bundle. Redact
> phone numbers and personal names in docs, logs and commits.

## Files

| File | What it covers |
|---|---|
| `01-product.md` | Who uses FarmLink, every flow (SMS-first), the 28 AI tools, the web surfaces |
| `02-architecture.md` | Stack, Cloud Functions, API routes, services, env var names, deploy |
| `03-data-model.md` | Every Firestore collection with fields, enums and pilot document counts |
| `04-square-mapping.md` | **Each v1 entity mapped to a Square API**, what Square can't hold, proposed architecture, build order |
| `05-known-issues.md` | Security findings and design gaps from the 2026-09-20 audit |
| `06-current-state.md` | What production runs now, where the v1 data is, how to get it out |

## Where the code and the rest of the record are

- **v1 code:** tag `farmlink-v1-final` (`8c4cfea`). Branch `revert/farmlink-v1` has the same
  tree plus this folder.
- **The SJCA market-manager rework** that replaced v1 in production (Sept–Nov 2026) is
  preserved at tag `sjca-rework-final` and branch `archive/sjca-rework` (`52f45b3`). Its
  `docs/SPEC.md` §1–2 is the full v1 audit this package summarises.
- **v1 design docs in the repo root:** `farmlink_architecture.md`,
  `farmlink_system_architecture.svg`, `farmlink_ai_conversation_engine_flow.svg`,
  `farmlink_entity_relationship_diagram.html`, `farmlink_v2.jsx` (UI prototype).
  `README.md` and `farmlink_architecture.md` describe an **older Postgres/BullMQ/Twilio
  stack** that was replaced on 2026-05-31. Trust this package and the code over them.

## Moving it to the SJCA account: what you do

1. Give the SJCA account access to the GitHub repo (it's public, so cloning works without
   access; pushing needs collaborator access or a fork under an SJCA org).
2. Open a Claude Code session in the SJCA account on a clone of the repo, check out
   `revert/farmlink-v1`, and paste the brief above.
3. Connect Square in that account: a Square developer app (sandbox first) and, if the
   account has one, a Square connector/MCP server so Claude can read the catalog.
4. Keep the Firebase project `arkansaslocalfoodnetwork` where it is until the new build
   is decided. It still runs the SJCA rework and holds the v1 export (`06-current-state.md`).
