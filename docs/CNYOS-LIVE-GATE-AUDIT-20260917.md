# CNYOS live gate audit — 2026-09-17

This is a read-only observation of the public hosts and the checked-out
candidate. It is not a deployment authorization, a Production attestation, or
evidence of a real LINE/OAuth/backup run.

## Candidate inspected

- Branch: `codex/production-guard-20260917`
- Exact source commit: `2dee10e06af53e32702d86bc406768b4b951a215`
- Working tree: clean after the commit was pushed
- Local verification: `npm run check` exited 0, including the LINE gateway,
  patient identity, backup/restore contracts, and production gate contracts.

## Public observations

The following read-only requests were made with normal TLS verification:

| Host | `deploymentId` | clinic code | patient identity | LINE webhook |
| --- | --- | --- | --- | --- |
| `https://cnyos.cloud` | `chananya-clinical-staging` | `CHANANYA-STG` | `enabled=false` | `enabled=false` |
| `https://cnyos.netlify.app` | `chananya-clinical-staging` | `CHANANYA-STG` | `enabled=false` | `enabled=false` |

Both public hosts also advertise the staging OAuth redirect origin
`https://cnyos.netlify.app`. Therefore `cnyos.cloud` is not currently a
Production artifact and must not receive real LINE events or patient data.

Their public `deploy-manifest.json` reports source commit
`0adba0dee32216c344d7ed852dce9ade80d87671` and build context `production`, but
also reports `deploymentId: chananya-clinical-staging`, `CHANANYA-STG`, and
`qrIssuer: CHANANYA-STG`. A production build context alone does not override
the staging tenant identity; the manifest therefore fails the production
classification gate.

## LINE flow implemented in source

1. The owner adds the Chananya LINE OA and receives a privacy-safe Patient Card
   link from the signed Messaging API webhook.
2. Staff searches the patient by HN and issues a one-time link code through the
   clinic-scoped RPC.
3. The owner opens the LIFF Patient Card, enters that code, confirms consent,
   and receives an opaque one-time QR (90-second expiry).
4. Authenticated staff scans the QR; the database consumes it atomically and
   creates the encounter. Replay and expiry are denied.

The OA never accepts or sends HN, diagnosis, medicine, or other clinical data in
chat. The explanatory card/help text was clarified in the candidate commit.

## Evidence still required before live activation

- A separate Production tenant configuration and Production Supabase project.
- Production-only Netlify Function secrets, set in the platform secret store:
  `LINE_LIFF_ID`, `LINE_LOGIN_CHANNEL_ID`, `LINE_MESSAGING_CHANNEL_ID`,
  `LINE_MESSAGING_CHANNEL_SECRET`, `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`,
  `LINE_OA_PATIENT_CARD_URL`, `PATIENT_IDENTITY_HMAC_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `CNYOS_RUNTIME_EXPECTED_CLINIC_ID`.
- LINE Developers webhook verification and a dedicated synthetic account run
  covering add-friend, link-code consent, QR scan, replay/expiry denial,
  revoke, and manual HN fallback.
- Protected exact-commit evidence for encrypted backup, isolated restore, PITR,
  monitoring, incident drill, and independent security/privacy/clinical/
  quality approvals.

Until these external artifacts exist, `release-readiness.json` must remain
`commercialProductionReady: false` and all 16 gates must remain `pending`.

The repository now includes a read-only fail-closed check for the eventual
Production runtime. After the Production artifact and secrets are configured,
run it with the exact expected identity (never with secrets in the command):

```bash
CNYOS_LIVE_CHECK_ACK=READ_ONLY_RUNTIME_CHECK \
CNYOS_LIVE_ORIGIN=https://cnyos.cloud \
CNYOS_LIVE_EXPECTED_DEPLOYMENT_ID=chananya-clinical-production \
CNYOS_LIVE_EXPECTED_CLINIC_CODE=CHANANYA-PRD \
CNYOS_LIVE_EXPECTED_REDIRECT_ORIGIN=https://cnyos.cloud \
npm run verify:live-line
```

It must reject the current public staging artifact and will only write a
redacted capability evidence file after identity, redirect, LINE enablement,
and no-PHI chat checks all pass.
