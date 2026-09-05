# CNYOS Production Milestone Stack

This document is the operational stack for moving CNYOS to a defensible production-grade release. It separates source completeness, live staging verification, operational readiness, pre-deployment approval, production deployment and admission of real patient data.

## Promotion and admission rule

`release-readiness.json` is a **source-controlled fail-closed policy baseline**. It deliberately remains `commercialProductionReady=false`, with no `releaseCommit` and no embedded passed evidence. It must never be edited to approve the Git commit that contains it, because doing so would create a self-referential commit hash.

Production deployment may be approved only when a protected production environment supplies `PRODUCTION_RELEASE_ATTESTATION_JSON` for the exact checked-out `main` commit. That external attestation must approve production, reference all required pre-deployment gates in the policy-defined order, bind every gate to the exact same release commit and retain artifact/reviewer/timestamp references.

Real patient data remains blocked after deployment until the separate `public_production_deployment_attestation` passes for that exact commit and Git tree on the intended production origin.

Source code, Preview visibility, synthetic fixtures, a successful Netlify deploy, a dashboard, a runbook or a passing contract suite are not sufficient by themselves.

## Stack

| Milestone | Exit condition | Current state |
|---|---|---|
| M0 — Source provenance | Exact candidate commit, locked dependencies, source manifest and migration-chain evidence retained | PASS on trusted `main`; repeat on final release commit |
| M1 — Contract + public runtime surface | Complete `npm run check` passes, including role matrix, tenant isolation, owner controls, clinical handoffs, pharmacy/production/quality, backup/restore contracts, PostgreSQL behavioral smoke, restricted Netlify publish surface and public-deployment verifier safeguards | PASS on trusted `main`; repeat on final release commit |
| M2 — Isolated staging runtime | Isolated staging database is migrated, tenant-bound and authenticated; every role passes allowed actions and denial cases; Owner OFF/ON is proven against already-issued sessions | PENDING live protected-workflow evidence |
| M3 — LINE OA operational boundary | Signed real callback, follow/unfollow, consent, revoke, QR issue/expiry/replay denial and manual HN fallback pass with a dedicated synthetic account | PENDING live protected-workflow evidence; live switch remains disabled until verified |
| M4 — Backup and disaster recovery | Encrypted off-site export completes; isolated restore passes record/digest/clinical-chain checks; measured RPO/RTO retained; managed database backup/PITR configuration is separately verified | PENDING live evidence; Drive manifest/restore evidence is not yet present |
| M5 — Clinical/quality governance | Independent Quality producer-versus-approver segregation passes and clinical-safety review has no unresolved release blocker | PENDING independent evidence |
| M6 — Privacy, security and legal | Privacy/PDPA, application-security and applicable legal review close with zero unresolved release blockers | PENDING independent evidence |
| M7 — Production operations | Monitoring and alert routing are active; named primary/alternate operational owners exist; alert delivery is tested; incident containment, rollback and recovery drill evidence is retained | PENDING operational evidence; runbook exists but does not itself satisfy the gate |
| M8 — Candidate release controls | Exact release-candidate source provenance, automated checks, review status and enforced merge protection are verified before production deployment | PENDING final-commit/protection evidence; `main` currently lacks enforced protection |
| M9 — Production promotion approval | Protected external attestation for the exact `main` commit passes `npm run verify:production-promotion`; promotion evidence is retained | BLOCKED until M2–M8 pass and the production environment contains the exact-commit attestation |
| M10 — Production deploy + admission | Exact-artifact workflow builds and publishes the approved commit/tree, verifies the Netlify deploy ID, then proves public commit/tree, headers and forbidden-path denial | BLOCKED until M9 passes; real patient data prohibited until post-deploy attestation passes |

## Current hosting interpretation

The public `cnyos` Netlify project is currently a deployment surface, but its live configuration is staging/synthetic-oriented. A Netlify `ready` state means the bundle deployed successfully; it is not a production-readiness attestation.

The current CNYOS deployment predates the restricted `dist/` publish hardening and does not carry the exact trusted release provenance required by the post-deploy gate. It must not be treated as the final production artifact.

The separate white-label sites preserve the intended tenant topology. Promotion must keep tenant database, credentials, backup destinations, identity configuration and Owner control bound to the exact target site; no cross-tenant reuse is permitted.

## Evidence discipline

Each external pre-deployment gate record must include at least:

- `commit` — full 40-character release commit SHA
- `artifact` — retained artifact, report or immutable evidence reference
- `verifiedAt` — verification timestamp
- `verifiedBy` — accountable reviewer or verifier identity

The protected release attestation additionally requires `releaseCommit`, `approvalReference`, `approvedAt`, `approvedBy`, `approvedForProduction=true`, and `realPatientDataAdmission=blocked_pending_post_deploy_attestation`.

The operations gate additionally requires monitoring configuration references, named primary/alternate responders, a successful alert test and a non-production rollback/deployment-recovery drill. See `docs/PRODUCTION_OPERATIONS_RUNBOOK.md`.

The post-deploy attestation additionally binds the public deployment to the exact Git tree and verifies the runtime surface after the production deploy exists.

A gate may not be claimed passed in source. The source policy stays pending/fail-closed; live approval exists outside the release commit so it can safely reference that immutable commit.

## Final promotion sequence

1. Freeze the exact candidate commit on `main`.
2. Run complete CI and retain exact-commit evidence.
3. Run authenticated isolated-staging role/Owner verification on that exact commit.
4. Run real LINE staging verification on that exact commit.
5. Complete encrypted export and isolated restore drill; verify managed backup/PITR separately.
6. Close Quality, privacy/security/clinical-safety/legal reviews with zero release blockers.
7. Activate production monitoring, name the accountable operational roster, prove alert delivery, and retain rollback/recovery-drill evidence.
8. Verify final candidate provenance plus enforced review/merge protection and record every pre-deployment gate artifact against the same release commit.
9. Assemble the external release attestation for that immutable commit and store it as protected production environment secret `PRODUCTION_RELEASE_ATTESTATION_JSON`; do not modify the release commit.
10. Run the manual `Production promotion gate` workflow with explicit promotion confirmation.
11. Run `Exact CNYOS production deploy` for that same approved `main` commit; it captures the previous deploy, builds/verifies `dist`, publishes it, verifies the new Netlify deploy ID and runs public attestation while real-data admission remains blocked.
12. Run/retain the Production post-deploy attestation for exact commit/tree and required routes/security headers/404 denial of internal repository paths.
13. Confirm monitoring observes the deployed release and critical alert routes remain armed.
14. Admit real patient data only after the post-deploy attestation artifact is retained and all operational owners approve admission/reopening where required.
