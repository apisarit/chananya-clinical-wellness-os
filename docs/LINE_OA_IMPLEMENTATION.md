# LINE OA operational messaging

## Scope

This release adds the server-side LINE Official Account runtime that was missing from the existing LIFF Patient Card. It is operational messaging only:

- verified welcome/help replies and a link to the one-time Patient Card;
- explicit, revocable and versioned consent for appointment and service notifications;
- appointment booked, confirmed, reminder, rescheduled and cancelled messages;
- idempotent webhook processing and an outbox with bounded retries;
- encrypted recipient identifiers and environment-bound transaction/audit backup.

Marketing broadcasts, diagnosis, prescriptions, clinical advice and free-text chat ingestion are outside this release. Chat text is classified in memory for a small menu response and is not persisted. A LINE conversation is not a clinical record.

## Runtime topology

1. LINE sends `POST /api/line/webhook`.
2. The Function reads the raw body and verifies `x-line-signature` with the Messaging API channel secret before JSON parsing.
3. `webhookEventId` is claimed in Postgres. A processed event cannot reply twice; failed transient events can be reclaimed after the lease expires. Contact state is advanced only by a newer event timestamp, so an out-of-order redelivery cannot reverse a later block/unblock state.
4. The LINE user ID is HMAC-hashed for the patient-identity join and separately encrypted with AES-256-GCM for future push delivery. The encryption binding includes clinic, environment, deployment, Messaging channel, subject and key ID.
5. When a patient opts in during first link, one database transaction consumes the one-time link code and records the clinic-bound OA consent. A failed OA boundary check rolls both operations back, so the patient never receives a false link failure after the code was consumed.
6. The Function never stores raw chat text, ID tokens, reply tokens or webhook bodies.
7. Appointment changes add template identifiers to `line_oa_notification_outbox`; they do not add free-form messages.
8. `line-oa-dispatch` runs every five minutes, claims at most eight rows, decrypts the recipient only in memory and uses a stable `X-Line-Retry-Key` for safe Messaging API retry. A `409` carrying LINE's accepted-request ID is recorded as a successful prior delivery rather than a dead letter.
9. LINE webhook, outbox and delivery evidence is exported in the encrypted `transactions` Drive domain. Contacts and consent preferences are exported in the encrypted `patients` domain. Encryption keys are never included in Drive exports.

## Required channel relationship

The LINE Login/LIFF channel and Messaging API channel must be under the same LINE provider. LINE issues the same user ID across channel types only under the same provider. This is a manual console gate and must be recorded in staging evidence before activation.

Use a dedicated staging LINE OA, LINE Login channel, LIFF app, Supabase project, Netlify site and synthetic LINE account. Do not reuse Production credentials in staging.

## Protected environment values

Set these only in Netlify's protected Function environment. Do not commit or place them in browser configuration.

| Variable | Purpose |
|---|---|
| `LINE_OA_ENABLED` | Must be exactly `true` to activate webhook and dispatch |
| `LINE_OA_ENVIRONMENT` | `staging` or `production` |
| `LINE_OA_ACTIVATION_ACK` | `STAGING_LINE_OA_ENABLED` or `PRODUCTION_LINE_OA_ENABLED` |
| `LINE_OA_DEPLOYMENT_ID` | Environment-specific deployment identity |
| `LINE_OA_CLINIC_ID` | Clinic UUID for this isolated deployment |
| `LINE_PATIENT_CARD_URL` | HTTPS patient-only LIFF URL; staging must contain a staging marker |
| `LINE_MESSAGING_CHANNEL_ID` | Messaging API channel ID; must share provider with LINE Login |
| `LINE_MESSAGING_BOT_USER_ID` | OA bot user ID used to reject misrouted webhooks |
| `LINE_MESSAGING_CHANNEL_SECRET` | Webhook HMAC verification secret |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | Server-only Messaging API token |
| `LINE_OA_ENCRYPTION_KEY_BASE64` | 32 random bytes encoded as base64 |
| `LINE_OA_ENCRYPTION_KEY_ID` | Recoverable version label for the encryption key |
| `PATIENT_IDENTITY_HMAC_SECRET` | Existing stable HMAC identity key; do not rotate without a re-link migration |
| `SUPABASE_URL` | Environment-specific Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for audited RPCs |

The recipient encryption key must be backed up in the approved secret-recovery process. Replacing it without a versioned re-encryption procedure prevents delivery to existing encrypted contacts.

The protected `staging` GitHub Environment also needs `STAGING_LINE_ID_TOKEN` from the dedicated synthetic account and `STAGING_LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`. The workflow never prints or retains either value. Immediately before running **Real LINE OA + hybrid identity staging E2E**, the dedicated account must add/message the staging OA so a current signed webhook creates its encrypted contact. The target must be the published isolated staging deploy because Netlify does not run scheduled functions automatically on Deploy Previews.

## LINE Developers Console activation

1. Enable Messaging API for the staging LINE Official Account.
2. Confirm that the Messaging API channel and LINE Login/LIFF channel belong to the same provider.
3. Set the webhook URL to `https://<patient-staging-origin>/api/line/webhook`.
4. Keep `LINE_OA_ENABLED=false`, deploy, and verify that the endpoint fails closed with `503`.
5. Add the protected variables, set the staging acknowledgement, then set `LINE_OA_ENABLED=true`.
6. Use **Verify** in the Messaging API tab. The signed empty-event request must return `200`.
7. Enable **Use webhook** and **Webhook redelivery**. Disable overlapping OA Manager auto-reply/greeting behavior or document the exact intended coexistence. Blocking the OA purges recipient ciphertext, withdraws operational messaging and cancels pending delivery; following again does not silently restore consent.
8. Add the dedicated synthetic LINE account, open the LIFF Patient Card, link a synthetic HN and independently opt in to operational messages.

LINE requires signature verification for every webhook and recommends duplicate detection with `webhookEventId` when redelivery is enabled. Reply and push APIs support up to five message objects; this implementation sends one operational text message per request.

## Exact-commit staging evidence

The LINE gate remains pending until one protected staging run proves all of the following against the same Git commit and deployed manifest:

- signed empty webhook verification;
- invalid-signature rejection before JSON parsing;
- follow, message, postback and unfollow lifecycle;
- duplicate and redelivered `webhookEventId` denial;
- no raw user ID or chat text in Postgres, logs, artifacts or Drive export;
- LIFF link consent separated from operational-message consent;
- consent withdrawal and patient identity revoke both cancel pending delivery;
- appointment booked/confirmed/reminder/rescheduled/cancelled templates;
- stable `X-Line-Retry-Key`, transient retry, terminal failure and dead-letter behavior;
- blocked contact ciphertext purge;
- one encrypted Drive export and isolated restore verification for the new LINE OA tables;
- HN/manual service remains fully available with LINE disabled.

The protected workflow calls LINE's official webhook-test and profile endpoints, then waits up to seven minutes for the five-minute Netlify dispatcher. It retains only synthetic IDs, exact-commit provenance and delivery outcomes; the ID token, access token and raw LINE user ID are excluded from artifacts.

## Rollback

Set `LINE_OA_ENABLED=false` first. The webhook then returns `503` and the scheduled dispatcher performs no work. HN, manual check-in and LIFF QR identity remain independent. Do not delete contacts, consent, webhook events, outbox rows or delivery evidence during rollback. Revoke the channel access token only if compromise is suspected; preserve the encryption and HMAC keys for recovery and audit.

Official references:

- [Receive Messaging API webhooks](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
- [LINE user IDs and provider boundaries](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)
