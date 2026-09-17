# CNYOS pre-launch live route check — 2026-09-17

This note records a read-only route observation for the public pre-launch site. It is a test note for reviewer follow-up, not a release approval or a production attestation.

## Scope and safety boundary

- Base URL: `https://cnyos.netlify.app`
- Observed at: `2026-09-17T22:39:00+07:00`
- Source under review: the checklist changes in this commit (record the exact revision with `git rev-parse HEAD` when submitting for review)
- Method: unauthenticated HTTPS `GET` requests only; no form submission, no patient data, no Supabase write, no LINE callback, and no production deployment.
- The checklist added in this commit is intentionally in-memory and local-only. It does not persist a checked state and cannot approve a release.

## Route observations

All requested public routes returned HTTP 200 and HTML during this observation. A 200 response only proves that the route served a document; it does not prove authentication, role authorization, database behavior, callback signing, or clinical correctness.

| Route | HTTP | Document title | HTML checkboxes | Disabled attributes | Result |
| --- | ---: | --- | ---: | ---: | --- |
| `/` | 200 | Chananya Clinical OS — Operations | 1 | 1 | Served; dynamic checks not run |
| `/appointments.html` | 200 | Chananya Appointment Center | 0 | 0 | Served; dynamic checks not run |
| `/check-in.html` | 200 | Patient Check-in — Chananya Clinical OS | 1 | 0 | Served; LINE/HN credential test not run |
| `/foundation.html` | 200 | TTM Foundation v0.2 • Chananya | 0 | 0 | Served; dynamic checks not run |
| `/clinical-v3.html?step=history` | 200 | Chananya Clinical Workspace | 19 | 0 | Served; clinical write flow not run |
| `/outcomes.html` | 200 | Chananya Clinical Outcomes | 0 | 0 | Served; dynamic checks not run |
| `/pharmacy.html` | 200 | Chananya Pharmacy Workstation | 1 | 0 | Served; transaction flow not run |
| `/production.html` | 200 | Chananya Production Workstation | 0 | 0 | Served; inventory writes not run |
| `/quality.html` | 200 | Quality Release Workstation | 0 | 0 | Served; QC approval not run |
| `/admin.html` | 200 | Chananya Admin Task Center | 0 | 0 | Served; privileged actions not run |
| `/owner-control.html` | 200 | CNYOS Owner Control Console | 0 | 17 | Served; owner credentials not used |

## What remains unverified

This observation does not close any production gate. Authenticated role coverage, tenant isolation, signed LINE callback and QR replay/expiry, encrypted backup and isolated restore, PITR, migration rollback, monitoring delivery, incident drill, independent security/privacy/clinical/commercial/quality approvals, protected release provenance, and post-deployment exact-commit attestation still require their respective controlled evidence.

The public site was not changed by this note. The local checklist is not visible on the public artifact until a separately reviewed build is deployed, and this note deliberately does not request that deployment.

## Jaoball re-review request

Please review the same source commit after the checklist and contract-test changes are committed. The review should confirm that the checklist remains non-persistent, credential-free, and separate from clinical read-only controls. Approval must be recorded by the reviewer; this note is not an approval.

## Post-SQL follow-up

Re-run the staging-only SQL observer, verifier, and migration-ledger reconciliation with authorized staging credentials. Attach command output and exact migration/commit identifiers to the release evidence packet; do not run these statements against Production from this branch.
