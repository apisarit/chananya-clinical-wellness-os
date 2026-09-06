# CNYOS privileged-function exposure baseline

**Observed:** 2026-09-06 (Asia/Bangkok)  
**Source baseline:** `a22f8162fb4096b2ca99208d948e103e99962ac9`  
**Parent workstream:** #35  
**Production mutation in this workstream:** none

## Purpose

Record the live Supabase privilege baseline before changing function ACLs. This
is evidence of exposure and drift; it is not a production-readiness approval,
penetration-test result, tenant-isolation attestation, or authorization to use
real patient data.

## Read-only inventory results

| Project | Environment | Public functions | SECURITY DEFINER | Anonymous executable SECURITY DEFINER | Authenticated executable SECURITY DEFINER | Trigger-bound SECURITY DEFINER |
|---|---|---:|---:|---:|---:|---:|
| `hsmnjwxurlmsizndjlun` | Chananya clinical staging | 147 | 141 | 81 | 84 | 18 |
| `qbkuyjavtvjdzfdprgqa` | Jitarsa clinical staging | 146 | 140 | 9 | 78 | 18 |
| `qptxnrldzzinlcabudjv` | Current production project | 29 | 24 | 12 | 22 | 3 |

Every project also reported one security-invoker function without a pinned
`search_path`; on Chananya staging this is `public.set_updated_at()`.

## Chananya trigger-function classification

Chananya staging currently contains 23 non-internal public trigger functions.
Sixteen are executable by at least one Data API runtime role. Trigger functions
are invoked by PostgreSQL through trigger bindings and are classified as
internal implementation functions, not supported RPC endpoints.

The source migration in this branch:

- revokes function execution from `PUBLIC`, `anon`, `authenticated`, and
  `service_role` for every non-internal public trigger function;
- leaves trigger bindings and ownership unchanged;
- pins `public.set_updated_at()` to `pg_catalog, public`;
- fails closed if any Data API runtime role retains trigger-function execution.

## Migration-ledger divergence

| Project | Recorded migration state | Decision |
|---|---|---|
| Chananya staging | 32 entries, ending at `202608311800_owner_subscription_control` | Reconcile against the 45 source migrations before applying this branch |
| Jitarsa staging | No migration-ledger entries returned | Do not apply a new migration until schema provenance is reconstructed and verified |
| Current production | No migration-ledger entries returned | No direct patch; production remains blocked |

The repository migration contract expects 45 ordered, fingerprinted migration
files, including the 2026-09-01 owner-control, backup, service-role, and
subscription-closure sequence. Applying a newer migration before reconciling
those states would make rollback, restore, and exact-commit attestation
unreliable.

## Required execution order

1. Validate each project schema against the repository's migration fingerprints.
2. Repair or reconstruct the ledger only through the existing guarded recovery
   process and retain its output as evidence.
3. Apply this ACL closure to Chananya staging only.
4. Re-run the read-only inventory and Supabase Security Advisor.
5. Run authenticated role regression tests and negative RPC tests.
6. Repeat on Jitarsa staging after its provenance is established.
7. Submit the exact remediated commit and evidence to an independent security
   assessor.
8. Consider production only through the existing promotion gate.

## Evidence query

Use `supabase/manual/security_definer_exposure_inventory.sql`. Retain the
project reference, execution timestamp, exact source revision, result, and
reviewer identity with every run.
