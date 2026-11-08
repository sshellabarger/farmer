# 2027 vendor application — review against the draft Rules & Regulations

Written 2026-11-08 from three inputs the owner supplied: the **2027 Rules & Regulations
draft of 2026-11-02** (text kept at `docs/wlrfm-rules-2027-draft.txt`), the **2026 Jotform
application** (`ALFNWLRFMVendorApp042026`, field inventory below) and the **vendor space
map** (`docs/wlrfm-vendor-map.jpg`, stalls V1–V22). It answers two questions — what the
rules change about the application, and what the 2027 application in this app must
contain — and scopes the build (SPEC §8 Phase 4, revised).

## 1. What the 2027 rules change

| Rule (2027 draft) | 2026 Jotform | What the 2027 application needs |
|---|---|---|
| Season: every Saturday 8–12, **Apr 3 – Nov 27 2027, 35 markets** | 2026 dates in a notice | New WLRFM schedule version (`2027-04-03`…`2027-11-27`); the form states the 2027 dates and fee maths from one source |
| §3 **Vendor categories**: Farmers/Ranchers · Specialty Food · Food-adjacent · Crafts (special events only); balance kept by the manager | Product types (produce, meat, eggs, dairy, honey, value-added, non-food, prepared food, education) | Add a category choice mapped to the four; keep the product-type sub-sections for the practice questions; mark Crafts as events-only; split "non-food" into food-adjacent vs crafts |
| §3 **All items must be listed; no non-approved items; mid-season additions need approval** | Free-text product lists | Structured product list per category, stored on the producer (`products[]`), shown to the manager; an "approve added items" admin action and a producer-side request path |
| §3 **Weekly market report required** | — | Acknowledgement + a texting number with SMS consent — this is also the missing `producers.phone` for Phase 3 (every 2027 applicant becomes textable) |
| §3 **Random farm/facility visits** | — | Acknowledgement; farm address already collected (keep) |
| §3 **Insurance: $1M GL, additional insureds KBK-Breck / WLRFM / ALFN, proof annually before the first market, Hold Harmless after acceptance** | "Do you carry insurance?" yes/no | Ask current coverage (yes / no / need guidance); certificate upload optional at application, **required before the first market** — tracked per membership with an expiry date and a reminder; Hold Harmless as a post-acceptance e-sign link (text supplied by the owner) |
| §3 Application process: annual, signed acknowledgement, approval before participation, mid-season applicants, trial period, acceptance criteria | Signature pad; rules checkbox | Typed e-signature (legal name + date + IP/timestamp) and the rules acknowledgement with the rules version recorded; "new this year?" flag; admin notes for trial period |
| §4 **Application fee $15, non-refundable, annual** | In-form card payment (total showed $0.00) | Zeffy payment link after submission with the email prefilled; `fee_status` on the application (manual "mark paid" until the Phase 5 Zeffy sync) |
| §4 **Booth fees**: seasonal $700 (two instalments) or **$600 paid in full on acceptance**; daily $25; electric $50/season or $5/market; fees per booth, extra spaces pay per space | Booth preference 1 or 2; electrical yes/no; commitment yes/no + frequency | Rate choice (seasonal / daily) replacing `fee_plan: weekly\|season\|both`; spaces (1 or 2 side-by-side); electricity; intent to pay in full; the form shows the computed season total; booth fees are collected on acceptance, not in the application |
| §5 **Booths assigned by the manager**, ~12'×12', vendor brings 10'×10' tent | — (no map) | Map shown in the form; optional stall preference (V1–V22, "not guaranteed"); returning vendors state last year's stall; assignment itself is the manager's — booth map, usual booth, per-date assignments, booth-number texts (Phase 4) |
| §7 **Permits**: none for whole produce / Food Freedom / honey & sorghum / microgreens; **required** for non-FF canned goods, dairy, TCS foods; **prohibited** wild mushrooms, sprouts; egg labelling; meat USDA-inspected and frozen; Plant Board for plants | Prepared-food permit upload required; value-added permit optional | Permit rule shown inline per product type; upload required (or "will provide before first market") when dairy / TCS / non-FF canned goods are selected; Food Freedom labelling checkbox; USDA facility name for meat; Plant Board compliance for plants; prohibited items stated and screened in review |
| §8 Attendance: as scheduled; two unapproved absences → loss of space | Commitment + frequency | Seasonal = all 35 markets; daily = frequency (every other week / monthly / occasional) + optional months; the weekly check-in handles actual dates |
| §10 **Marketing consent** (names, logos, photos, descriptions) | — | Acknowledgement; optional logo upload and a short public description + social links (feeds the website vendor list in Phase 6) |
| §7 Sales tax handled independently | — | Notice only |

Not in the rules but in the 2026 form and worth keeping: agricultural practices
(certified organic / CNG / no chemicals / conventional / n-a), "another vendor brings my
products" (co-marketing, no booth), payment methods accepted (cash, card, check, WIC,
SNAP), the per-category practice checklists and descriptions (produce; meat/eggs/dairy;
honey incl. hives, inspection, facility, flavoured; value-added facility, certifications,
permits, batch records), description and years in operation, other outlets, website and
social, additional information.

Programs other than WLRFM (ALFN Online Market, Green Groceries) were on the 2026 form.
This app serves SJCA's markets; the recommendation is a **WLRFM-only** 2027 application
(Argenta added as a second market when its schedule is known) — see D24.

## 2. The 2027 application (proposed structure)

One public page at `/apply` (mobile-first, saves progress per section in the browser,
no login), submitting to `POST /api/applications`:

1. **You and your business** — contact name, business name, email, **mobile for market
   texts** + SMS consent, website, social, farm/business address, description and years
   in operation, other outlets, new vendor or returning (returning: last year's stall).
2. **What you sell** — vendor category (one or more of the four), then one sub-section
   per product type selected, each with its structured product list, practice checklist,
   the permit rule for that type and the required upload where the rules require one.
   Prohibited items stated.
3. **Your booth** — the map; rate (seasonal / daily + frequency); spaces (1 / 2);
   electricity; payment-in-full intent; computed season total; stall preference;
   co-marketing option; payment methods accepted.
4. **Insurance and agreements** — coverage status and optional certificate; the five
   acknowledgements (rules & regulations with version/date, weekly report, farm visits,
   marketing consent, products-listed-only); typed signature.
5. **Submit → fee** — confirmation, then the $15 Zeffy link; the admin queue shows
   `fee_status`.

Everything a reviewer needs lands on the application document and, on approval, on the
producer (`products`, `phone`, consent, logo, description) and the membership
(`fee_plan`, `spaces`, `electric`, `usual_booth_id`, `insurance{status, expires_at}`,
`hold_harmless_signed_at`).

## 3. Booth map and assignment (Phase 4)

From the map: two rows of 11 stalls — **V1–V11** (west, V1 at the north end) and
**V12–V22** (east, V12 at the north end), a food-truck slot between V7/V8 and V17/V18, the
**power station** by V12–V14 and **check-in & power** at the V11/V22 end. Vendors enter
from Breckenridge, set up, then park in vendor parking.

- `booths` seeded for WLRFM as V1–V22 with `row`, `order`, `power` (the manager flags
  which stalls reach power — D26), `size`, `notes`, plus a `food_truck` slot; an admin
  editor to rename/add/retire stalls and set attributes (positions drawn as the two rows,
  not free-form).
- `producer_memberships.usual_booth_id` set from the application's preference or by the
  manager.
- Per market date: once the check-in deadline passes, the app drafts assignments for the
  producers who said they are attending (usual booth first, then open stalls, power
  constraints honoured), the manager adjusts on `/admin/market-dates`, approves, and the
  engine's existing drafts/approve/booth-text hooks send "Your booth this Saturday is V7"
  texts. History append-only (`booth_assignments`).
- A printable one-page map for the check-in table and the data the Phase 6 `/thisweek`
  draft needs.

## 4. Operational notes from production (2026-11-08)

- No producer has a phone yet, so Phase 3 never texted anyone; the 2027 application fixes
  that at the source (consented texting number on every application).
- Since the deploy the SMS number received six inbound texts: five were lender spam, each
  answered once by the unknown-number auto-reply (a paid segment to a spammer). D29
  proposes dropping that reply.
- 29 WLRFM dates are still `collecting` (seven past deadlines processed silently); the
  2026 season ended 2026-10-31. A 2027 schedule version is needed before dates for 2027
  generate.

## 5. Decisions for the owner (defaults apply unless changed)

- **D24** — 2027 application is WLRFM-only (no ALFN Online / Green Groceries sections). Default: yes.
- **D25** — $15 application fee via a Zeffy payment link shown after submission, prefilled with the applicant's email; admins mark paid until the Phase 5 sync. Default: yes; needs the Zeffy form URL.
- **D26** — Which stalls can reach power? Default: the manager flags them in the booth editor; the form asks "needs electricity" and the drafting step honours it.
- **D27** — Owner supplies: the Hold Harmless text, the insurance guidance link ("HERE"), the ADH Farmers Market Vendor Guidelines and Food Freedom links, the final rules PDF to host at `/rules`. Placeholders until then.
- **D28** — Daily-rate vendors give a frequency (and optional months), not specific Saturdays. Default: yes.
- **D29** — Stop auto-replying to unknown numbers (STOP/HELP still honoured; known producers unchanged). Default: yes.
- **D30** — Returning vendors get an emailed/texted link that prefills the application from their producer record. Default: yes.
- **D31** — Fee plan vocabulary becomes `seasonal | daily`; season total shown on the form uses the §4 amounts as market-level configuration (editable per season, never hard-coded). Default: yes.

## 5a. Owner-supplied values (2026-11-08) — seed these as WLRFM settings at the Phase 4 deploy

- **D25 payment link** (`payment_links.application_fee_url`, also the booth-fee link until a
  separate form exists): https://www.zeffy.com/en-US/organizations/arkansas-local-food-network
- **D27 insurance guidance** (`legal.insurance_help_url`): the WLRFM Insurance Information
  Sheet, https://drive.google.com/file/d/1-2v-fWv0ByvmBaah2brOmCY3ZBvwC8KI/view?usp=sharing —
  it tells uninsured applicants to answer "no", apply, then secure \$1,000,000 general
  liability for the market season once approved (financial assistance of up to \$100 was
  offered for 2026, first come first served); insured applicants answer "yes" and obtain a
  Certificate of Insurance naming **KBK-Breck, LLC c/o Kelley Commercial Partners** and
  **ALFN/West Little Rock Farmers Market** as additional insureds; FLIP and Campbell Risk
  Management are listed as resources. The form's insurance section copy and the
  acceptance email should link to it; the 2027 draft adds "The WLRFM" as a third named
  insured — owner to confirm the sheet is updated for 2027.
- **D27 ADH Farmers Market Vendor Guidelines** (`legal.adh_guidelines_url`):
  https://healthy.arkansas.gov/wp-content/uploads/FarmersMarketGuidelines-7-28-25.pdf
- **D27 Food Freedom / Homemade Food Guide** (`legal.food_freedom_url`):
  https://healthy.arkansas.gov/wp-content/uploads/Homemade-Food-Guide-2025-July.pdf
- Source of the links: the 2026 rules Google Doc ("WLRFM 2026 Rules and Regs"), which also
  carried a Cooperative Retail Booth clause (each producer applies and is approved
  individually; products labelled per producer; one point person may sell) that the 2027
  draft no longer spells out — the form keeps the co-marketing question and the review
  queue shows it.
- Still pending from the owner: the Hold Harmless text (`legal.hold_harmless_markdown`)
  and the adopted 2027 rules for `/rules` (`legal.rules_markdown`, `rules_version`).

## 6. 2026 Jotform field inventory (for the record)

Farm/business: full name; farm/business name; email; phone; website; social; address;
description + years; other outlets; agricultural practices (radio). Market-specific:
program (WLRFM / ALFN Online / Green Groceries); rules link + 2026 season notice; rules
acknowledgement; commit to all markets (y/n); ideal frequency; another vendor brings
products (y/n); electrical access (y/n); booth preference (1 / 2 side-by-side); payment
options accepted (cash, card, check, WIC, SNAP); ALFN agreement (y/n); Green Groceries
description. Practices: product types (checkbox list of nine) with conditional
sub-sections — prepared food description + Retail Food Establishment Permit upload;
education description; produce list + 22-item practices checklist + description;
meat/eggs/dairy list + 13-item practices checklist + description; honey description,
hives, registered/inspected, commercial facility, flavoured; value-added list, facility
and certifications, permit upload (optional), batch records; non-food description;
insurance (y/n); additional info; signature. Payment page: "ALFN Application Fee" $15,
quantity, card fields. Buttons: Save, Submit Application.
