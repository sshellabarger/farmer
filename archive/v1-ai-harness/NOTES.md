# v1 AI conversation harness (archived 2026-09-20, decision D8)

FarmLink v1 answered every inbound text with a Claude tool-calling loop
(`conversation.ts`, ~28 tools registered in `tools-index.ts`, originally
`src/tools/index.ts`). The SJCA tool has no AI assistant; inbound texts go through
the keyword handler in `src/services/inbound.ts` (SPEC §7.4). These two files are
kept as a **pattern reference** only. They do not compile against the current tree:
the tool modules they import (`inventory.ts`, `orders.ts`, `signup.ts`, …) were
deleted and are recoverable from tag `farmlink-v1-final` under `src/tools/`.

## What is generic (reusable if an assistant is ever wanted)

All of it is in `conversation.ts` → `processInboundMessage()`:

| Piece | Where | Notes |
|---|---|---|
| **History load** | steps 2–4: find-or-create a `conversations` doc by phone, append the inbound `messages` subdoc, load the last 20 and replay them as `user`/`assistant` turns; dedupe if the last stored message is the one being processed | Sort in memory to avoid a composite index. |
| **Tool loop** | step 7: `while (response.stop_reason === 'tool_use')` — run every `tool_use` block through `executeTool`, push an `assistant` turn with the raw content and a `user` turn with the `tool_result` blocks, call the model again | `executeTool` throws on an unknown name; errors become `is_error` tool results, never crashes. |
| **Hallucination guard** | `MUTATING_TOOLS`, `ACTION_CLAIM_PATTERNS`, `responseClaimsAction()`, the verification pass after the loop | If the final text claims an action (added/created/scheduled/…) but **no mutating tool was even attempted**, re-prompt with a `SYSTEM CHECK` message and `tool_choice: 'any'` (max 2 rounds). Attempted-but-failed tools deliberately do **not** trigger it (forcing a retry caused duplicate writes). |
| **Date injection** | `dateBlock`: today's date + weekday in the market timezone appended to the system prompt as `CURRENT CONTEXT` | Added Jul 2026 after the model resolved "the 14th" to the wrong year. Any assistant that handles dates needs this. |
| **`ai_metadata`** | step 9: stored on the outbound `messages` subdoc: `model`, `usage`, `tools_called`, `mutations_succeeded` | Cheap observability; kept per reply, not per conversation. |
| **Registry shape** | `tools-index.ts`: `toolDefinitions: Anthropic.Tool[]` + `toolHandlers: Record<name, (input, ctx) => Promise<unknown>>` + `executeTool()`; `ToolContext = { db, env, userId?, phone }` | Definitions and handlers are keyed by the same name so a missing handler is a runtime error, not silent. |

## What is domain (do not port)

- `SYSTEM_PROMPT` — entirely about inventory, orders, the delivery depot, produce photos, buyer "markets", directory/connections. The `DEPOT` import came from `src/config/depot.ts` (single-depot logistics, retired).
- The context builder (step 5) — loads `farms`, `inventory`, `products`, `farm_market_rels`, `markets` for the texting user.
- The `NEW USER` branch that asks the model to collect signup details and call `user_signup` (unreachable in practice: the routes bounced unknown numbers before this ran).
- 20 of the 28 tools: `user_signup`, `inventory_*`, `produce_photo`, `order_*`, `market_query`, `notify_markets`, `recurring_order_*`, `delivery_*`, `analytics_summary`, `directory_search`, `connection_*`, `pending_connections`, `view_link`, `email_send` (the model chose recipient and body — a phishing vector behind an unauthenticated webhook).
- Domain-neutral tools were `feedback_submit/query/update` and `reminder_set/list/update`; their HTTP equivalents survive in `src/routes/feedback.ts` and `src/routes/reminders.ts`.

## Model and cost notes

`MODEL = 'claude-sonnet-4-6'`, `max_tokens: 500` per call, up to 2 correction rounds; each
inbound text was 1–4 model calls plus 3–6 Firestore reads for context. `ANTHROPIC_API_KEY`
remains in the app only for `src/services/error-notify.ts` (alert diagnosis).
