# LINE OA Messaging Gateway

Status: source implementation present; real LINE Developers callback evidence pending. This gateway does not change `commercialProductionReady=false`.

## Boundary and purpose

The LINE Official Account is a secure doorway to the existing LIFF Patient Card. It is not a clinical chat bot and it does not diagnose, prescribe, collect symptoms, or expose protected health information in chat.

Supported inbound events:

- `follow`: sends a privacy-safe welcome and Patient Card shortcut;
- text or postback requests for Patient Card, status, appointments, privacy, revocation help, or menu;
- `unfollow`: records delivery state and stops responding;
- unsupported message types, groups, and rooms: acknowledged without exposing a patient workflow.

The reply never includes patient name, HN, date of birth, allergy, diagnosis, treatment, medicine, appointment detail, invoice, or payment detail. Clinical and identity work continues inside the verified LIFF Patient Card and staff Clinical OS.

## Callback

Netlify Function route:

```text
POST /api/line-oa-webhook
```

Staging callback URL:

```text
https://chananya-clinical-staging.netlify.app/api/line-oa-webhook
```

The function verifies `x-line-signature` over the exact raw request body using HMAC-SHA256 before JSON parsing or database access. A LINE console verification request with a valid signature and an empty `events` array returns HTTP 200.

## Required Functions environment

```text
LINE_MESSAGING_CHANNEL_ID
LINE_MESSAGING_CHANNEL_SECRET
LINE_MESSAGING_CHANNEL_ACCESS_TOKEN
PATIENT_IDENTITY_HMAC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
LINE_LIFF_ID
```

Optional:

```text
LINE_OA_PATIENT_CARD_URL
LINE_OA_BRAND_NAME
```

`LINE_OA_PATIENT_CARD_URL` defaults to `https://liff.line.me/<LINE_LIFF_ID>`. The Messaging API channel and LINE Login/LIFF channel must be created under the same LINE Developers provider. Do not place the channel secret, access token, identity HMAC key, or Supabase service-role key in browser code, tenant JSON, GitHub source, or deploy manifests.

In Netlify, scope all secrets to Functions runtime. Staging and Production must use separate LINE channels/tokens, Supabase projects, identity keys, and patient origins.

## Idempotency and audit

Migration `202608292100_line_oa_messaging_gateway.sql` adds:

- `line_oa_webhook_events`: hashed event/payload identifiers, sanitized action code, processing/reply state, retry count, and no message content;
- `line_oa_contact_states`: keyed subject/channel hashes and followed/unfollowed state;
- `register_line_oa_webhook_event(...)`: atomic claim, stale/failed retry, duplicate suppression, and linked identity evidence;
- `finalize_line_oa_webhook_event(...)`: processed/ignored/failed outcome;
- `line_oa_webhook_evidence(...)`: non-PHI staging evidence counts.

Raw LINE user IDs, message text, reply tokens, access tokens, and webhook payloads are never stored. The same HMAC identity key used by verified LINE Login converts a signed OA `source.userId` to the existing subject hash. Significant actions for an already-linked person append sanitized `patient_identity_events`; those canonical identity events are included in the encrypted transaction/audit Drive backup. Transport idempotency rows are operational telemetry and are not treated as the clinical record.

## Activation sequence

1. Apply all migrations through `202608292100_line_oa_messaging_gateway.sql` to the isolated staging Supabase project.
2. Configure the staging LIFF endpoint URL to the patient-only staging origin.
3. Set the required Netlify environment values for Functions runtime only.
4. Deploy the exact candidate commit and confirm `GET /api/line-oa-webhook` reports `enabled=true`.
5. Set the LINE Messaging API webhook URL to the staging callback above, enable webhooks, and run **Verify**.
6. With a dedicated staging LINE account, add the OA, send “บัตรผู้รับบริการ”, open the LIFF card, complete consent/link, issue QR, consume it once, test replay/expiry denial, request revocation help, revoke, and confirm no-phone HN fallback.
7. Retain the LINE console verification timestamp, Netlify deploy ID/source commit, sanitized function evidence, database evidence, and mobile screenshots in the protected staging evidence set.

## Release gate

Source/unit/PostgreSQL tests prove signature validation, no-PHI routing, idempotency, audit, and reply construction. They do not prove LINE platform configuration or a real callback. The `line_callback` gate remains pending until the exact deployed commit receives a real signed LINE event and the complete consent/link/revoke/QR/fallback staging flow passes.
