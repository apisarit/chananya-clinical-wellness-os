# Domain, input and TTM review gap note — 2026-09-17

## Live observation

Read-only fetches of `tenant-config.js` showed that both public hosts currently serve the same staging configuration:

| Host | deploymentId | clinic code | redirect origin | Supabase project |
| --- | --- | --- | --- | --- |
| `https://cnyos.netlify.app` | `chananya-clinical-staging` | `CHANANYA-STG` | `https://cnyos.netlify.app` | `hsmnjwxurlmsizndjlun` |
| `https://cnyos.cloud` | `chananya-clinical-staging` | `CHANANYA-STG` | `https://cnyos.netlify.app` | `hsmnjwxurlmsizndjlun` |

Therefore `cnyos.cloud` is not yet a production cutover. It is a second public host for the staging artifact/database. Do not accept real patient data or call this an authorization/synchronization success.

## Changes prepared in source

- Production-only host canonicalization is guarded by `deploymentId=chananya-clinical-production`; staging is never redirected to Production.
- OAuth login now prefers the validated configured redirect origin, and a stale production callback on `cnyos.netlify.app` is forwarded to `cnyos.cloud` before code exchange.
- Temperature entry is a text field with decimal keyboard/input support and accepts both `36.5` and `36,5`; it no longer forces a one-degree number spinner. The stored value remains numeric.

These changes are source-only until a protected production build is reviewed and deployed.

## TTM knowledge approval gap

The current Foundation page reads `review_status` and keeps clinical inference at `candidate_only` until approved evidence exists. It does not yet provide a persistent approval action. A safe approval implementation still needs a staging-only audited RPC with:

1. role and tenant checks (named clinical reviewer, not a generic authenticated user),
2. source/version and evidence requirements,
3. producer-versus-approver separation,
4. append-only decision evidence and reason,
5. a synchronized review queue for concepts, relations and diagnostic rules.

Do not add a direct browser `UPDATE review_status` control as a shortcut; that would bypass the required authorization and audit boundary.
