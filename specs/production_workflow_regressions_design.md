# Production workflow regression repairs

Scope: six reported browser symptoms; local source/tests only. Preserve the
existing production feature set and server/RLS protections. Base is PR67 merge
`6d934b2cf2d5b154e4d12d02b18049b0dd064134`; do not claim that the observed
production UI serves this commit without deployment metadata.

## Acceptance and ownership

| ID | Requirement | Owner / files |
| --- | --- | --- |
| UX-01 | Finance RPC failure displays error/retry only, never a simultaneous successful-empty claim; old responses cannot replace newer state. | finance worker: app.js, focused operations regression test |
| UX-02 | Sign-off disabled without selected Encounter, authorized role, successful readiness read, Diagnosis and Treatment; preserve existing backend RPC checks and actual record-lock state. | clinical worker: clinical-signoff.js, signoff regression test |
| UX-03 | Dropdown selection updates encounter URL parameter, preserves step and reload selection, clears invalid/empty identity. | clinical worker: clinical-v3.js, selection regression test |
| UX-04 | Header/selector/context format patient identity consistently; stale reads/events cannot repaint another Encounter. No claim that wrong patient data was previously proven. | clinical worker: clinical-v3.js, clinical-context-guard.js, regression test |
| UX-05 | Dashboard and register use matching appointment date/time fields and explicit Asia/Bangkok day boundaries within existing access scope. Error/denied load must not appear as zero. | finance worker: app.js, operations regression test |
| UX-06 | Audit distinguishes load failure, denied access and successful empty result, with retry where meaningful. | finance worker: app.js, operations regression test |

## Frontend

Use existing vanilla-JS/DOM conventions. Explicit loading/error/empty/success
states, user-initiated retry and monotonically increasing request versions.
Record-lock UI and readiness-to-sign are distinct states. Save/reload must retain
the same selected ID; reset old chart state immediately on selection change.
No new dependencies, styling rewrite, patient fixtures from live data or PHI logs.

## Backend / integration

Keep existing Supabase schema, role model, RLS and RPC signatures unchanged.
Use ordinary authenticated reads with existing scope; UI guards supplement,
never replace, server enforcement. Sign-off backend remains authoritative.
Classify structured error codes without assuming every failure is a migration
problem. Do not substitute an empty array for an unverified failed result.

## Security checkpoint

- Auth/authz: preserve runtime capability checks and server sign-off guards;
  fail closed on unreadable readiness. No service-role/credential access.
- Inputs: validate selected ID against loaded, authorized rows; parameterized
  Supabase filters, no interpolated SQL or broader account/tenant query.
- Output: retain escaping/textContent for names/errors; generic safe messages,
  no raw internal errors/PHI added to visible UI or logs.
- No backend rate-limit, migration, privilege, secret or hosted-control changes.
- No real sign-off, clinical write, finance transaction, push or deploy.

## Verification

Each bug requires an executable synthetic DOM/VM regression, including negative
and stale/out-of-order paths. Run existing affected contract tests and `npm run
check` before handoff; independent final review checks regression and missing
coverage. Public runtime identity may be observed read-only; no patient rows
needed. Local passing tests are not browser/live acceptance.
