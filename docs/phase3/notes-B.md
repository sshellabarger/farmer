# Phase 3 — executor B release notes (messaging)

Branch `rework/p3-messaging`, built against `main` (`1bcd13b`, which already carries the
2026-09-22 Timestamp hotfix and the voip.ms 45s timeout — three commits ahead of the
contract's stated base `2308727`; nothing in those three commits touches B's files).

## What was built

- **`src/services/inbound.ts`** — rewritten per contract §5.1:
  - STOP/START now update **both** `users.sms_opt_out_at` and, when the number matches a
    producer, `producers.sms_opt_out_at` + `producers.sms_consent` (§2.6). Always replies,
    even to an unknown number, unchanged from Phase 1.
  - For a matched producer: `findOpenCheckin` (via the copied `open-checkin.ts`) resolves
    the newest valid, still-`collecting` check-in link.
    - **HELP** replies with the check-in link when one is open, else the generic help text.
    - **YES/NO** against an open check-in calls `recordAttendingNext` (creates a minimal
      `source: 'sms'`, `partial: true` check-in, or updates only `attending_next` /
      `attending_next_raw` on an existing one) and replies with the link.
    - **Anything else** (including YES/NO with no open check-in) is forwarded once to
      `staffForMarket` for the producer's open-checkin market, or their first `active`
      membership market, or nobody market-specific (admins still get it) — then a
      once-per-24h courtesy reply (`REPLIES.received[_with_link]`).
  - No producer match (a known staff user, or a wholly unknown number): the Phase 1
    stopgap is unchanged — HELP, then the "service has changed" reply, once per 24h.
  - `repliedRecently` was narrowed to `kind === 'auto_reply'` rows only, so a
    `checkin_link`/`checkin_reminder`/`forwarded_inbound` send never suppresses the
    courtesy acknowledgement (contract requirement, tested explicitly).
  - New exports: `YES_KEYWORDS`, `NO_KEYWORDS`, `normalizeKeyword`. `REPLIES` gained
    `help_with_link`, `attending_yes`, `attending_no`, `received`, `received_with_link`;
    the four pre-existing strings (`unsubscribed`, `resubscribed`, `help`, `closed`) were
    reworded to "SJCA Markets" per the contract's exact text (`closed` kept verbatim).
    `tests/sms-webhook-auth.test.ts` needed no edit — it references the `REPLIES.*`
    constants, never the literal strings, so the wording change is invisible to it, as the
    contract predicted.
  - **Deviation (recorded, not silent):** YES/NO matching for the producer branch is done
    against the **first whitespace token** of the normalized body
    (`normalizeKeyword(body).split(/\s+/)[0]`), not the full normalized string. The
    contract defines `YES_KEYWORDS`/`NO_KEYWORDS` as exact-match sets but also requires
    (§7.2 test list) that a free-text reply like `"no thanks"` be recognised as NO with
    `attending_next_raw: 'no thanks'` — that's only possible by matching on the first
    word. STOP/START/HELP still match on the full normalized keyword (unchanged, single-
    word commands). `body.trim()` (not the normalized keyword) is still what's stored in
    `attending_next_raw`, per the contract.

- **`src/services/sms.ts`** — only the §1.5 `SmsKind` hunk applied; verified byte-for-byte
  before/after hashes (`bc85465d…` → `a484b7b6…`) match the contract exactly.

- **`src/routes/sms.ts`** — only the `/status` handler changed, to the documented no-op
  from §5.3: accepts any body, writes nothing to `messages`, logs one info line, returns
  `{ ok: true, updated: false }`. `messages.status` stays terminal at `'sent'` for voip.ms
  because the provider has no outbound delivery-receipt callback (sources cited in-code and
  in the contract). `src/app.ts` was **not** touched (out of B's ownership) — the route is
  already mounted there from Phase 1/2 and needed no new registration.

- **`src/utils/quiet-hours.ts`** (owned by B) and **`src/services/open-checkin.ts`** (A's
  file, copied verbatim) — both copied byte-for-byte from the contract's fenced source.
  Verified with `shasum -a 256`:
  - `src/utils/quiet-hours.ts` → `6bc96097823460541df4c217dcfdf26792756ce37f50db30f367cf57b400af34` (62 lines, matches contract)
  - `src/services/open-checkin.ts` → `7b93c44eef72e36cd229a0f8337acedc10c48ec115bde2232e9c03ef144c2715` (164 lines, matches contract)

## Tests

- `tests/quiet-hours.test.ts` — 18 cases: the wrapped-window boundary, both DST
  transitions with the "8h20m"/"10h20m real" checks from the contract, a same-day
  (non-wrapping) window, the empty window, a second timezone (America/New_York), and the
  bad-input throw.
- `tests/inbound-checkin.test.ts` — 14 cases covering YES/NO (including the "no thanks"
  free-text case and an existing form check-in being merged, not overwritten), an expired
  token falling through to forwarding, HELP with/without a link, forwarding scoped to the
  right market's staff with the inbound message id attached, the once-per-24h courtesy
  reply (including that a `checkin_link` row doesn't suppress it), a producer with neither
  a token nor a membership still reaching admins, STOP/START on a producer, an unknown
  number's unchanged behaviour, and a real-provider send failure landing the forward row as
  `failed` while the webhook still returns 200.
- `tests/sms-status.test.ts` — 4 cases: empty body, JSON delivery-report-shaped body,
  form-encoded body, and that a seeded `sent` row is left untouched.

## Deviation: `tests/quiet-hours.test.ts` numeric example

The contract's worked example "`America/New_York` 22:40 → next 08:00 in that zone (13:00Z
in September)" is off by one hour: America/New_York is EDT (UTC-4) in September, so
2026-09-15 22:40 local → 2026-09-16T02:40Z, and the next 08:00 local is
**2026-09-16T12:00:00Z**, not 13:00Z (that arithmetic is what Chicago, at UTC-5/CDT, would
give). Verified against `Intl.DateTimeFormat` directly (not just the code under test) before
writing the assertion. The test asserts the computed-correct `12:00:00.000Z`; every other
worked example in the contract (the Chicago wrapped-window cases and both DST transitions)
was independently re-derived and matched the contract's stated value exactly.

## What could not be verified from this branch alone

B's branch has no `link_tokens` producer beyond what its own fixtures seed (A's engine
doesn't exist here). The integration path — a real engine-minted token flowing into
`findOpenCheckin` and then into a YES/NO/HELP reply — is exercised only with hand-seeded
`link_tokens` rows here; the true end-to-end path is `tests/phase3-e2e.test.ts` (contract
§7.5), which is the integrator's job after the A → B → C merges land.

## Owner actions

None specific to B beyond what the contract's §8 already covers (this branch changes no
deploy-relevant configuration, adds no env keys, and the `/status` endpoint's no-op
behaviour is meant to be silently correct — no portal change is required for it).
