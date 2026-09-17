# WHO ICD-11 connection (staging)

The `/api/who-icd-search` Netlify function is a server-side, read-only connector
to the WHO ICD-11 MMS search API. It does not write diagnoses or replace Thai
traditional-medicine reasoning. A practitioner must review and approve any
mapping before it can be stored as knowledge.

## Required staging variables

Set these only in the staging function environment; never put them in
`NEXT_PUBLIC_*`, static files, Git, browser code, or a patient record:

```text
WHO_ICD_ENABLED=true
WHO_ICD_CLIENT_ID=<WHO ICD API client id>
WHO_ICD_CLIENT_SECRET=<WHO ICD API client secret>
WHO_ICD_RELEASE=2026-01
WHO_ICD_LANGUAGE=en
```

The client id/secret are issued by the WHO ICD API portal. The connector uses
the OAuth 2 client-credentials grant with scope `icdapi_access`, then sends
`API-Version: v2` to the fixed HTTPS MMS search endpoint. The caller must also
have an authenticated Supabase session and an active clinic access context with
one of `super_admin`, `admin`, `doctor`, or `practitioner`.

## Request

```http
POST /api/who-icd-search
Content-Type: application/json
Authorization: Bearer <Supabase access token>

{"query":"low back pain","limit":5}
```

Responses contain only bounded WHO entity ids, titles, optional codes, release,
and language. The endpoint rejects caller-provided URLs, redirects, anonymous
requests, stale sessions, and cross-clinic access. It performs a second access
check after the WHO request so a revoked role cannot receive a delayed result.

## Validation

Run the local contract without contacting WHO or Supabase:

```bash
npm run check:who-icd
```

This is a connector/read-only search only. A future write path for reviewed
Thai-term ↔ ICD mappings must use a tenant-scoped table, restrictive RLS,
provenance, practitioner approval, and an idempotent staging migration before
any production use.
