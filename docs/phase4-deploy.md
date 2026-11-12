# Phase 4 — deploy and first-use runbook

Written 2026-11-12 for the first Phase 4 deploy. Supersedes the order in
`docs/phase4-contract.md` §6 where the fix rounds changed it. Run everything from the main
checkout on `main`.

**There is no separate test project.** `arkansaslocalfoodnetwork` is production, and real
texts and emails are on there (`ALLOW_REAL_SENDS=true` in `.env.arkansaslocalfoodnetwork`).
"Testing" means using the live system with your own phone and email. Deploying is safe
because nothing Phase 4 adds sends anything until a staff member acts:

| What sends | When | To whom |
|---|---|---|
| Acceptance text + email | an admin approves an application with "send" ticked | the applicant's consented mobile / email |
| Invite email (+ text if a phone exists) | an admin runs "Invite to re-apply" or "Invite returning vendors" (only while applications are open) | returning producers (none has a phone today, so email only) |
| Agreement-link text | an admin presses "Send agreement link" | that producer |
| Booth texts | an admin **approves** a date's booth assignments | active current-season vendors with a phone |
| Nothing at all | the deploy itself, the backfill, settings changes, seeding booths | — |

The engine's new drafts step does nothing until booths exist; it can only draft for dates
whose market has ended, and nobody can be texted without an approval.

## 0. Pre-flight (2 min)

```bash
git checkout main && git pull --ff-only && git status
```

```bash
npm ci && npm run typecheck && npm test && (cd web && npm ci && npx tsc --noEmit)
```

Expect 834 passing tests. Then authenticate both CLIs (both expire):

```bash
firebase login --reauth
```

```bash
gcloud auth login && gcloud config set project arkansaslocalfoodnetwork
```

## 1. Backfill the season on the 39 Phase 2 memberships (optional, before or after)

The code already reads a missing `season` as 2026; this makes the data say so. It uses
Application Default Credentials (the service-account key in the repo root, or
`gcloud auth application-default login`).

```bash
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/backfill-membership-seasons.mjs --market wlrfm --season 2026 --db-project arkansaslocalfoodnetwork --dry-run
```

Expect `scanned 39 / updated 39 / already_set 0` (as a would-update count). Then repeat with
`--write` in place of `--dry-run`.

## 2. Deploy

```bash
npm run deploy:functions
```

No functions are added or removed (it should not prompt to delete anything; if it does,
stop and check). `api`, `processMarketDates`, `processReminders` and `rollMarketDates` are
updated.

```bash
npm run deploy:hosting
```

Ships `/apply`, `/rules`, `/agreement`, the admin pages and `/wlrfm-vendor-map.jpg`.
`deploy:firestore` is not needed (rules and indexes are unchanged).

## 3. Smoke checks (1 min)

```bash
curl -s https://farmlink.us/api/health
```

```bash
curl -s "https://farmlink.us/api/applications/config?market=wlrfm" | head -c 400
```

Expect 200 with the 2026 season label (or none) and `open_now: false` — applications stay
closed until step 4b. Then open `https://farmlink.us/apply?market=wlrfm` (shows "not open
right now"), `https://farmlink.us/admin/applications` and `https://farmlink.us/admin/markets`.
Watch the next `processMarketDates` log line (every 5 min) for `errors=0`:

```bash
gcloud functions logs read processMarketDates --gen2 --region us-central1 --limit 5
```

## 4. Set up the 2027 season (Admin → Markets → West Little Rock)

a. **Schedule versions → Add**: effective from `2027-01-01`, season `2027-04-03` to
   `2027-11-27`, Saturday, `08:00`–`12:00`. **Regenerate dates** with scope *season*:
   the 35 Saturdays of 2027 are created. The scope spans every schedule version, so a
   few 2026 Saturdays the survey import never had may be created as well; that is
   harmless (past dates are frozen and the engine only looks at the last 7 days).

b. **Season & fees**: label `2027`; application open/close dates (open today or earlier if
   you want to test now); schedule version = the 2027 one; fees (already prefilled with
   the 2027 defaults; save them so they are stored): application 15, seasonal 700,
   pay-in-full 600, installments 2, daily 25, electric season 50, electric per market 5;
   application-fee and booth-fee links
   `https://www.zeffy.com/en-US/organizations/arkansas-local-food-network`; booth map URL
   `/wlrfm-vendor-map.jpg`.
   *Setting the label to 2027 switches the dashboard, check-in texts and booth drafts to
   2027 memberships. The 2026 season is over, so nothing is lost; there are no 2027
   memberships yet, so the weekly engine goes quiet until vendors are approved.*

c. **Legal texts**:
   - Rules (markdown) + version (e.g. `2027-1`) — paste the adopted 2027 rules, or the
     draft (`docs/wlrfm-rules-2027-draft.txt`) clearly headed DRAFT for testing.
   - **Hold Harmless text + version — required before any approval that sends.** Without
     it an approve-with-send is refused (`hold_harmless_missing`) and the agreement cannot
     be signed. For testing you may paste a placeholder headed "TEST — not the real
     agreement" with version `test-1`; replace it and bump the version before real
     applicants are approved.
   - Insurance requirement wording (e.g. "$1,000,000 general liability naming
     KBK-Breck, LLC c/o Kelley Commercial Partners, ALFN/West Little Rock Farmers Market
     and The WLRFM as additional insureds") — until set, neither the form nor the
     acceptance email mentions amounts.
   - Insurance sheet: `https://drive.google.com/file/d/1-2v-fWv0ByvmBaah2brOmCY3ZBvwC8KI/view?usp=sharing`
   - ADH guidelines: `https://healthy.arkansas.gov/wp-content/uploads/FarmersMarketGuidelines-7-28-25.pdf`
   - Food Freedom guide: `https://healthy.arkansas.gov/wp-content/uploads/Homemade-Food-Guide-2025-July.pdf`

d. **Booths**: "Seed V1–V22 from the WLRFM map", then toggle **power** on the stalls that
   reach power (D26 — the map suggests the V12–V14 end and the V11/V22 check-in end).
   Keep the food-truck slot active only if a truck is expected.

## 5. Test end to end with your own details (15 min)

1. On your phone, open `https://farmlink.us/apply?market=wlrfm`. Submit a test
   application under a business name like "TEST — delete me", **your own** mobile and
   email, with a PDF upload (pick dairy to exercise the permit upload). Check the
   computed total (seasonal, 2 spaces, electric, pay in full = $1,250) and that the
   Zeffy button opens Zeffy. Don't pay.
2. Close the tab mid-form once and reopen: the draft should still be there.
3. `/admin/applications`: open the application, open the upload (if it fails with a
   `signBlob` / IAM error, see §6), mark the fee *waived*, **Approve** with "send" ticked
   and a usual booth. You should get the acceptance email and text (outside quiet hours,
   21:00–08:00; inside them the email goes and the text is held).
4. Open the agreement link from the text, sign it. The membership on
   `/admin/producers/detail` should read *active*, agreement signed.
5. Booths (optional now, or in the spring): open the 2027-04-03 date in
   `/admin/market-dates` → "Opening day assignments" → Draft. Your test vendor appears on
   their usual booth. **Do not Approve** unless you want the booth text on your phone;
   approving texts every seated vendor with a phone (only you, at this point).
6. Clean up: on the producer page set the 2027 membership *inactive*; on the application,
   withdraw it. If you drafted opening day, Redraft after deactivating so the test vendor
   drops off.

## 6. If an upload won't open (signed URLs)

Signing uses the functions runtime service account. Find it, then grant it the token
creator role on itself:

```bash
gcloud functions describe api --gen2 --region us-central1 --format='value(serviceConfig.serviceAccountEmail)'
```

```bash
gcloud iam service-accounts add-iam-policy-binding <that-account> --member=serviceAccount:<that-account> --role=roles/iam.serviceAccountTokenCreator
```

## 7. Going live with real vendors (later)

- Replace any placeholder Hold Harmless / rules text and bump the versions.
- Season & fees → "Invite returning vendors…" → dry run first (expect 39 candidates;
  texts skipped for no phone, emails per the imported addresses; producers without an
  email show as `skipped_no_contact`) → confirm. Invitations only go while applications
  are open; during quiet hours the texts are held — run it again in the morning and only
  the missing texts go.
- Review the practice checklists and permit wording (market data; edit via
  `PATCH /api/markets/wlrfm` with the whole `product_types` array — see
  `docs/phase4/notes-A1.md`).

## 8. Rollback

Code: redeploy the previous `main` (`f0ddd81`) with the two deploy commands. Data written by
Phase 4 (new collections `applications` v2 docs, `application_uploads`,
`application_invites`, `application_keys`, `booths`, `booth_assignments`, 2027
memberships, the market's new fields) is additive; the Phase 3 code ignores it. The
backfilled `season` field is harmless to Phase 3. PITR is on if anything worse happens.
