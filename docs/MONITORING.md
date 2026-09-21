# Error Monitoring & Alerts

This doc covers (1) the automatic error alerts the app sends, and (2) how to
review and monitor errors yourself in the Google Cloud Console.

The pre-rework snapshot of this document is `archive/ops-log/MONITORING-2026-06.md`.

---

## 1. Automatic alerts (text + email)

When an unhandled error occurs, the app automatically:

1. **Logs** it to Google Cloud Logging (always).
2. **Researches a fix** — for non-Anthropic errors, it asks Claude Haiku to
   explain the likely cause and first fix step (`src/services/error-notify.ts`;
   this is the only remaining use of `ANTHROPIC_API_KEY`).
3. **Emails** a detailed report to `ALERT_EMAIL` (error, context, AI analysis,
   stack trace, and a category-specific fix hint).
4. **Texts** a concise summary + suggested fix to `ALERT_PHONE`.

### Where alerts fire from
- **API routes** (`api-route`) — the global Fastify error handler in
  `src/app.ts` catches any unhandled route error (5xx only; Zod validation
  failures return 400 without alerting).
- **SMS inbound** (`sms-inbound`) — failures while processing a voip.ms
  inbound text. The webhook still answers 200 so voip.ms does not retry.
- **Scheduler** (`scheduler:reminders`) — the `processReminders` job (every
  15 minutes).
- **Web client** (`web-client`) — the browser posts uncaught errors to
  `POST /api/errors` (rate-limited, unauthenticated by design).

### Throttling (important)
Alerts are **de-duplicated per error signature** (category + first line of the
message) and limited to **one alert per 30 minutes** per signature. Repeats in
that window are counted and reported in the next alert ("N similar errors were
suppressed"). This prevents a recurring failure from flooding your phone/inbox or
running up SMS costs. The dedup state lives in the Firestore `error_alerts`
collection.

### Configuring recipients
In `.env`:
```
ALERT_EMAIL=you@example.com    # blank = disable email alerts
ALERT_PHONE=+15555550100       # blank = disable SMS alerts
```
After changing, redeploy: `npm run deploy:functions`.

---

## 2. Reviewing errors in the Google Cloud Console

The project is **arkansaslocalfoodnetwork**. Both functions run in **us-central1**:

| Function | Trigger | What it does |
|---|---|---|
| `api` | HTTPS (`/api/**` via Hosting rewrite) | The Fastify app |
| `processReminders` | Cloud Scheduler, every 15 min | Sends due reminders by SMS (skips opted-out users) |

`processRecurringOrders`, `freshnessAlerts` and `sendNotification` were retired in
Phase 1 of the SJCA rework; the next `npm run deploy:functions` prompts to delete
them and their Cloud Scheduler jobs. If they still appear in the console, that deploy
has not happened yet.

### A. Logs Explorer (the main tool)
1. Go to <https://console.cloud.google.com/logs/query?project=arkansaslocalfoodnetwork>
2. Paste a query and click **Run query**. Useful queries:

   **All errors across the API function:**
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="api"
   severity>=ERROR
   ```

   **The reminders job:**
   ```
   resource.labels.service_name="processreminders"
   severity>=ERROR
   ```

   **Search by text (e.g. voip.ms failures):**
   ```
   resource.type="cloud_run_revision"
   textPayload=~"voip.ms" OR jsonPayload.err.message=~"voip.ms"
   ```
3. Use the time-range picker (top right) to widen/narrow the window.
4. Click any entry to expand the full JSON, including `jsonPayload.err.stack`.

> Note: Cloud Functions v2 run on Cloud Run, so the resource type is
> `cloud_run_revision` and `service_name` is the lower-cased function name.

### B. Error Reporting (auto-grouped errors)
1. Go to <https://console.cloud.google.com/errors?project=arkansaslocalfoodnetwork>
2. This automatically groups recurring errors, shows occurrence counts, first/last
   seen, and trends. Click a group to see samples and stack traces.
3. You can **mute** resolved groups and **link** them to issues.

### C. Functions dashboard
1. Go to <https://console.cloud.google.com/functions/list?project=arkansaslocalfoodnetwork>
2. Click a function → **Logs** tab for that function's stream, or **Metrics** for
   invocation count, error rate, execution time, and memory.

### D. From your terminal
```bash
# Tail recent logs for the API function
firebase functions:log --only api

# Or via gcloud (more filtering power)
gcloud logging read \
  'resource.labels.service_name="api" AND severity>=ERROR' \
  --project=arkansaslocalfoodnetwork --limit=20 --freshness=1d
```

### E. Message log
From Phase 1 every inbound text and every outbound reply/broadcast is written to
the Firestore `messages` collection (`direction`, `to`, `from`, `body`, `kind`,
`status`, `provider_message_id`, `error`). A `status: failed` row is the first
place to look when someone says they did not get a text.

---

## 3. Optional: proactive alert policies (catch what you're not watching)

To get notified even for errors that don't route through the app (cold-start
crashes, OOM, etc.), set up a Cloud Monitoring alert:

1. Go to <https://console.cloud.google.com/monitoring/alerting?project=arkansaslocalfoodnetwork>
2. **Create Policy** → condition on metric
   `Cloud Run Revision → Request count` filtered to `response_code_class = 5xx`,
   or a **log-based metric** on `severity>=ERROR`.
3. Add a notification channel (email / SMS / Slack) and save.

This is belt-and-suspenders on top of the app-level text/email alerts above.

---

## Quick reference

| Need | Where |
|------|-------|
| One-off error detail + stack | Logs Explorer (Section 2A) |
| "What's been failing repeatedly?" | Error Reporting (Section 2B) |
| Function health / error rate | Functions → Metrics (Section 2C) |
| Tail logs in terminal | `firebase functions:log --only <fn>` |
| Did a text go out? | `messages` collection (Section 2E) |
| Change who gets alerts | `ALERT_EMAIL` / `ALERT_PHONE` in `.env` + redeploy |
