# v1 SMS channels (archived 2026-09-20, decision D5)

FarmLink v1 supported three inbound/outbound channels behind `src/services/sms.ts`.
Production only ever ran **voip.ms**; Telnyx and WhatsApp were never configured in the
live project. Per SPEC §9 D5 the tool keeps voip.ms only.

| File | What it was |
|---|---|
| `telnyx.ts` | Telnyx v2 send + ed25519 webhook signature verifier (`verifyTelnyxWebhookSignature`) |
| `whatsapp.ts` | Meta WhatsApp Cloud API send + HMAC-SHA256 `x-hub-signature-256` verifier |
| `whatsapp-signature.test.ts` | Regression test for the WhatsApp verifier (timing-safe compare on mismatched lengths) |
| `sms-webhook-auth-telnyx.test.ts` | The Telnyx cases of `tests/sms-webhook-auth.test.ts` (signed/tampered/unsigned/replayed/unconfigured) |

Both verifiers are correct and tested; re-adding a provider is a ~30-line file plus a
case in `sendSms()`. Nothing in this folder is imported by the application or run by
vitest (`vitest.config.ts` limits tests to `tests/`).
