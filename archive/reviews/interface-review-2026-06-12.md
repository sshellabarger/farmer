# FarmLink Text-First Interface Review — 2026-06-12

Multi-agent review across 5 dimensions (SMS conversation UX, web-to-chat promotion, onboarding, channel parity, outbound re-engagement). All 41 findings adversarially verified against the code.

## 1. Overall assessment

The conversation engine is genuinely text-first — 28 Claude tools cover nearly every daily workflow, web chat and SMS share one brain and one Firestore thread, and there's a working anti-hallucination guardrail — but everything wrapped around that engine is web-first. Every acquisition moment funnels away from text: unknown numbers get bounced to the web signup URL despite a fully built conversational signup sitting unreachable behind the webhook gate, web signups never receive a kickoff SMS, and the FarmLink phone number appears literally nowhere in the entire web UI. Outbound messaging is mostly one-way FYIs whose replies arrive context-free, and the Jun 7 push-preferred delivery failure is still live for order notifications and inventory blasts. Today a pilot farmer who already knows the number can run their business by text; the product never tells anyone they can, and at its most critical moments it actively tells them the opposite.

## 2. Top 5 improvements (impact on text-first mission vs effort)

### 1. Let unknown numbers reach the AI — delete the web-signup bounce in all three webhooks
All three inbound handlers short-circuit unregistered numbers with "Please create an account at .../signup" before the AI runs (`src/routes/sms.ts:41-45`, `:89-94`, `:234-241`). The complete conversational signup already exists and works — NEW USER context at `src/services/conversation.ts:232-234` plus the `user_signup` tool in `src/tools/signup.ts` — it's just only reachable from the web test endpoint.

This is the single largest inversion of the mission. A farmer's first text ("I have 50 lbs of tomatoes") should start registration in 3-4 messages. It also fixes the invite dead-end: invites (`src/routes/invite.ts:42`) call FarmLink "text-first" then send a web link, and anyone who replies to that text hits the same bounce. Once removed, change the invite CTA to "Reply to this text to get set up."

**Effort:** 2-4 hours including a lead-logging record for first-contact numbers.

### 2. Stop silently losing messages — SMS-authoritative delivery and never-silent errors
Three flavors of silent loss:
- (a) Order notifications and the `notify_markets` Cloud Task still use push-preferred `notifyByPhone`, where FCM acceptance suppresses SMS — the exact Jun 7 failure mode, already fixed correctly in reminders but never back-ported (`src/services/order-notifications.ts:67-73`, `src/functions.ts:246-254`, `src/services/push.ts:59,77-98`; correct pattern at `src/services/reminders.ts:63-78`).
- (b) On AI/processing failure, Telnyx and WhatsApp users get total silence — catch blocks just log (`src/routes/sms.ts:51-54`, `:100-102`); the voip.ms handler 200 lines away (`sms.ts:246-254`) already does it right (classify, reply, notifyError). Extract it into a shared helper.
- (c) Photos/MMS are silently dropped on every channel (`sms.ts:18`, `:84`) while the product asks farmers to upload via a browser link — at minimum, reply with an acknowledgment instead of nothing.

"Reply to order!" blasts are the revenue-critical message; silence at a loading dock is indistinguishable from the product being dead.

**Effort:** ~1 day.

### 3. Make replies to notifications actually work — log every outbound send into the conversation thread, then give every template a reply CTA
The AI builds history exclusively from `conversations/{id}/messages`, and only the AI loop itself writes there (`src/services/conversation.ts:152-158`, `:355`). Every notification path (`notify_markets` at `src/tools/notifications.ts:69`, connection requests at `src/tools/connections.ts:65`, order status at `src/services/order-notifications.ts:38-53`, freshness, recurring) writes nothing — so a market replying "yes" to an inventory blast lands context-free.

Build one `logOutbound()` helper wrapping `sendSms` that writes the message plus structured metadata (inventory_id/order_id/rel_id) into the thread; the 20-message window then resolves referents automatically. Then upgrade the templates: only 2 of ~14 lead with a reply CTA today. Reminders → "Reply DONE or SNOOZE 1h"; order confirmed → "Reply DONE when dropped off"; standing-order short → name the items, "Reply with a substitute or SKIP"; freshness → reply-first instead of dashboard-first (`src/services/freshness-alerts.ts:57`).

This converts the entire outbound system from one-way FYI into the re-engagement loop a text-first product runs on. The same helper also fixes the inconsistent audit logging (section 3).

**Effort:** 1-2 days.

### 4. Build the promotion layer — the number everywhere, a kickoff SMS, and shared-thread disclosure
- (a) The FarmLink number appears nowhere in `web/src` — landing hero "Sell your harvest with a text" routes both CTAs to /login (`web/src/app/page.tsx:147-160`, `:299-307`). Expose it via NEXT_PUBLIC env, add a "Text START to (501) XXX-XXXX" `sms:` deep-link button on the hero, header, footer, settings (with save-to-contacts vCard).
- (b) The only SMS a web signup ever receives is a 5-minute OTP (`src/services/otp.ts:22`) — send a one-time kickoff SMS after first verification (`src/routes/auth.ts:153-189`) with 2-3 example commands, planting the thread in their messages app.
- (c) Web chat IS the SMS thread (same `processInboundMessage`, same Firestore conversation) but no surface says so — add one line to the chat header/empty state (`web/src/components/chat-widget.tsx:247-250`, `web/src/components/dashboard.tsx:347`) and a post-verify "here's how FarmLink works" step in signup (`web/src/app/signup/page.tsx:82-99`).

The strongest asset (one thread, two channels) is currently invisible plumbing; an engaged web user can use FarmLink daily and never learn texting exists.

**Effort:** ~1 day.

### 5. Close the parity gaps that force web round-trips for text-native tasks
In priority order:
- (a) `recurring_order_query` + a delete flag on `recurring_order_update` — today "pause my Tuesday order" is impossible because the required recurring_id is undiscoverable and delete doesn't exist (`src/tools/recurring.ts:68-84`, `src/tools/index.ts:239-252`; mirror the `reminder_list` pattern).
- (b) `profile_update` — no tool can save email/name/location/farm details, so `email_send` loops forever asking for an address it can't store (`src/tools/email.ts:17-19`; reuse the PUT whitelists in `src/routes/profile.ts:47-130`).
- (c) `connection_update` for priority/notification_delay/active — the knobs the SMS notification system runs on are web-only and `connection_request` hardcodes priority 50 (`src/tools/connections.ts:70-75`).
- (d) `invite_user` — "invite my buyer at 501-555-1234" is the pilot's natural growth loop and has no tool (reuse `src/routes/invite.ts:14-60`).

Each gap silently trains pilot users that the web is the real interface.

**Effort:** 2-3 days total; each tool is a thin wrapper over existing route logic.

## 3. Remaining findings by theme

### Bugs — fix immediately
- **Web signup is broken for food banks, pantries, hubs, and schools**: form offers food_hub/food_bank/food_pantry/school (`web/src/app/signup/page.tsx:310-318`) but the Zod enum rejects them (`src/routes/auth.ts:17`) — exactly the pilot's target market types; ~30-minute fix plus a smoke test. (High)
- `view_link` offers an 'analytics' tab that silently falls back to chat — `resolveInitialView` never maps it (`src/tools/index.ts:354-368`, `web/src/components/dashboard.tsx:82-89`); remove from the enum or wire a real view. (Low)
- `inventory_update` schema omits harvest_date though the handler supports it (`src/tools/index.ts:94-111`, `src/tools/inventory.ts:107`) — one-line fix. (Low)

### Public web trust
- **"Live Chat" nav exposes an internal dev simulator** ("Direct to AI — No Twilio", seeded test numbers, arbitrary phone impersonation against the live engine) to unauthenticated visitors (`web/src/components/header.tsx:46-50`, `web/src/components/live-chat.tsx:132-186`) — gate to admin. (High)
- Landing page shows fabricated stats ("2,400+ orders", "$89K weekly", "120+ farms") and invented testimonials to real ALFN/pilot visitors (`web/src/app/page.tsx:31-36`, `:53-57`, `:172-173`) — replace with honest pilot framing. (Medium)
- POST /check-phone returns {exists, name, role} pre-auth — account enumeration, only the global 100 req/min IP limit applies (`src/routes/auth.ts:119-130`). (Low)
- "Dev mode: any 6-digit code works" hint renders unconditionally in the production signup UI (`web/src/app/signup/page.tsx:382-384`); backend bypass is correctly gated. (Low)

### SMS channel robustness & compliance
- No STOP/opt-out or HELP keyword handling on any channel — a carrier-compliance requirement on the voip.ms path and the primary SMS discoverability mechanism (`src/routes/sms.ts`, `src/services/conversation.ts:20-82`); also no capability hint after signup. (Medium)
- No webhook idempotency: messageSid is accepted then discarded (`src/services/conversation.ts:101-110`), and handlers synchronously await the full Claude loop — provider retries can duplicate orders; use the provider message id as the doc id and ack-then-process-async. (Medium)
- Full inbound MMS photo support (beyond the minimal ack in fix #2): attach texted photos to the pending inventory item (`src/routes/sms.ts:18`, `:84`). (High, more effort)
- Channel identity untracked: proactive sends follow global SMS_PROVIDER not the user's channel, all messages logged as source 'sms', and `sendWhatsAppTemplate` (required outside Meta's 24h window) has zero call sites (`src/services/sms.ts:20-30`, `src/services/conversation.ts:148`, `:358`, `src/services/whatsapp.ts:55-108`). (Medium)
- Prompt-mandated emoji bullets force 70-char UCS-2 segments, max_tokens=500 truncation is unhandled, and only voip.ms splits long messages (`src/services/conversation.ts:26-31`, `:255-261`, `src/services/voipms.ts:12-53`, `src/services/telnyx.ts:24-31`) — add a character budget and reuse the splitter. (Medium)
- Anti-hallucination verification false-positives on read-only status words ("confirmed", "listed"), adding 2+ Claude calls of latency (`src/services/conversation.ts:91-99`, `:309-323`) — scope regexes to first-person claims. (Low)

### Outbound hygiene
- No quiet hours anywhere: standing-order SMS fire at the midnight CT cron (`src/functions.ts:163-178`), notify_markets delays aren't clamped to daytime, and there's no per-recipient batching — a 10-item listing session is 10 texts per market (`src/tools/notifications.ts:53-69`, `src/routes/admin.ts:134-142`). (Medium)
- Inconsistent outbound audit: freshness and recurring-order sends swallow errors with `.catch(() => null)` and log nothing (job reports lie), order-notification docs omit the recipient, broadcast per-recipient results are dropped (`src/services/freshness-alerts.ts:59-60`, `src/services/recurring-orders.ts:77-78`, `:103-104`, `src/services/order-notifications.ts:56-65`, `src/routes/admin.ts:144-154`) — largely solved by the logOutbound helper from fix #3. (Medium)
- Email reports are dead-ends: footer is just "FarmLink", no text-back pointer (`src/services/email.ts:14-26`). (Low)

### Web-to-text promotion polish
- Action forms never hint the text path — standing orders is a pure web form despite the landing page promising 'just text "standing order"' (`web/src/components/dashboard.tsx:855-958`, `:596-657`, `:1338-1369`); replicate the existing inventory-tip pattern (`dashboard.tsx:1244-1250`) with the real number, as a reusable component. (Medium)
- Empty states are dead ends or web funnels instead of first-text lessons (orders `dashboard.tsx:611`, markets `:1374`, farms `:1462`, standing orders `:727-729`, chat-widget.tsx empty state) — highest-leverage teaching spot. (Medium)

### Remaining parity gaps
- No `food_rescue_donate` tool: the freshness SMS says "donate or compost" with no path, while the web owns the whole Food Rescue Hero flow (`web/src/lib/food-rescue.ts:23-41`, `src/services/freshness-alerts.ts`). (Medium)
- ALFN/LFM sync is web-button-only — no `lfm_sync` tool, though inventory is added by text (`web/src/components/dashboard.tsx:1067-1078`, `src/routes/inventory.ts:60-70`). (Medium)
- Inventory delete and photo remove/replace are web-only — add a 'remove' mode to produce_photo and a delete path (`web/src/lib/api.ts:117`, `src/tools/index.ts:69-93`). (Low)
- `delivery_schedule_set` omits the 'areas' field the web editor supports (`src/tools/delivery.ts:5-40`). (Low)

### Cleanup
- Seven dead demo-data components (farmer-inventory, orders-list, recurring-orders, delivery-timeline, analytics, multi-farm-inventory, farmer-markets) plus sms-chat.tsx and demo-data.ts have zero importers — delete or move to /prototype (`web/src/components/`). (Low)

## 4. What's already good — preserve these
- **One brain, one thread**: web chat runs the identical `processInboundMessage` pipeline and the same Firestore conversation as SMS (`src/routes/sms.ts`). This is the product's strongest text-first asset — it only needs to be disclosed, not built.
- **Text is already the most capable surface**: 28 tools cover inventory, orders, reminders, connections, depot scheduling, photos, and analytics, and several capabilities (email reports, priority-tiered notify_markets blasts, analytics summaries) are deliberately text-exclusive — keep that direction.
- **The `view_link` tool plus the `?token=` auto-login bridge** (`web/src/lib/auth-context.tsx:48-60`) is exactly the right hand-off: long data goes to the web from inside chat, with no login friction.
- **The anti-hallucination verification pass and tool-error feedback loop** in `src/services/conversation.ts` are genuinely good guardrails — tighten the regex precision, don't remove them.
- **Phone-first identity done right**: OTP-only login with no passwords, and `src/services/reminders.ts` already implements SMS-authoritative delivery correctly post-Jun 7 — it is the template for fix #2, and the inventory tip and reminders copy prove the web-to-text teaching pattern works where it exists.
