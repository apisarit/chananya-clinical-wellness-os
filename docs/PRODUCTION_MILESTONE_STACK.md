# CNYOS Production Milestone Stack

This document is the operational stack for moving the current CNYOS release candidate to a defensible production-grade release. It intentionally separates source completeness from live verification.

## Promotion rule

Production promotion is allowed only when `release-readiness.json` reports `commercialProductionReady=true`, the release channel is `production`, every required gate is `passed`, and every gate retains evidence for the exact release commit.

Source code, Preview visibility, synthetic fixtures, a successful Netlify deploy, or a passing contract suite are not sufficient by themselves.

## Stack

| Milestone | Exit condition | Current state |
|---|---|---|
| M0 — Source provenance | Exact candidate commit, locked dependencies, source manifest and migration-chain evidence retained | PASS on the stacked release-candidate line; repeat on final commit |
| M1 — Contract and database behavior | Complete `npm run check` passes, including role matrix, tenant isolation, owner controls, clinical handoffs, pharmacy/production/quality, backup/restore contracts and PostgreSQL behavioral smoke | PASS on current candidate CI; repeat on final commit |
| M2 — Isolated staging runtime | Isolated staging database is migrated, tenant-bound and authenticated; every role passes allowed actions and denial cases; Owner OFF/ON is proven against already-issued sessions | PENDING live evidence |
| M3 — LINE OA operational boundary | Signed real callback, follow/unfollow, consent, revoke, QR issue/expiry/replay denial and manual HN fallback pass with a dedicated synthetic account | PENDING live evidence; source present and live switch remains disabled until verified |
| M4 — Backup and disaster recovery | Encrypted off-site export completes; isolated restore passes record/digest/clinical-chain checks; measured RPO/RTO retained; managed database backup/PITR configuration is separately verified | PENDING live evidence; backup/restore code is present but production claim remains blocked |
| M5 — Clinical/quality governance | Independent Quality producer-versus-approver segregation passes and clinical-safety review has no unresolved release blocker | PENDING review evidence |
| M6 — Privacy, security and legal | Privacy/PDPA, application-security and applicable legal review close with zero unresolved release blockers | PENDING independent review |
| M7 — Release controls | Deploy provenance matches the exact release commit; automated checks, review status and merge protection are verified | PENDING final-commit evidence |
| M8 — Production promotion | `npm run verify:production-promotion` passes for the exact checked-out commit and final evidence artifact is retained | BLOCKED until M2–M7 pass |

## Current hosting interpretation

The public `cnyos` Netlify project is currently a deployment surface, but its live configuration is deliberately staging-oriented and identifies synthetic-data/isolation controls. A Netlify `ready` state means the bundle deployed successfully; it is not a production-readiness attestation.

The separate `jitarsa` and `jitarsa-staging` projects preserve the intended white-label topology. Promotion must keep tenant database, credentials, backup destinations, identity configuration and Owner control bound to the exact target site; no cross-tenant reuse is permitted.

## Evidence discipline

Each hard gate must store evidence with at least:

- `commit` — full 40-character release commit SHA
- `artifact` — retained artifact, report or immutable evidence reference
- `verifiedAt` — verification timestamp
- `verifiedBy` — accountable reviewer or verifier identity

A gate may not be changed from `pending` to `passed` merely because a harness exists or a source-level contract test succeeds.

## Final promotion sequence

1. Freeze the exact candidate commit.
2. Run complete CI and retain exact-commit evidence.
3. Run authenticated isolated-staging role/Owner verification.
4. Run real LINE staging verification.
5. Complete encrypted export and isolated restore drill; verify managed backup/PITR separately.
6. Close Quality, privacy/security/clinical-safety/legal reviews with zero release blockers.
7. Record every gate artifact against the same release commit.
8. Change the machine-readable release claim only after evidence review.
9. Run the manual `Production promotion gate` workflow with explicit promotion confirmation.
10. Deploy that exact verified commit to the intended production site and re-check deploy provenance and smoke tests before admitting real patient data.
