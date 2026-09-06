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

The reviewed migration candidate in this branch:

- revokes function execution from `PUBLIC`, `anon`, `authenticated`, and
  `service_role` for every non-internal public trigger function;
- leaves trigger bindings and ownership unchanged;
- pins `public.set_updated_at()` to `pg_catalog, public`;
- fails closed if any Data API runtime role retains trigger-function execution;
- remains outside `supabase/migrations` until provenance is reconciled.

## Migration-ledger divergence

| Project | Recorded migration state | Decision |
|---|---|---|
| Chananya staging | 32 entries, ending at `202608311800_owner_subscription_control` | Guarded ledger repair candidate; do not replay migrations blindly |
| Jitarsa staging | No migration-ledger entries returned | Guarded ledger reconstruction candidate; do not replay migrations blindly |
| Current production | No migration-ledger entries returned | Older schema; no ledger repair or direct patch; production remains blocked |

The repository migration contract expects 45 ordered, fingerprinted migration
files, including the 2026-09-01 owner-control, backup, service-role, and
subscription-closure sequence.

## Read-only provenance probe

The probe sampled nine later functions, three later relations and seven later
columns from the 2026-09-01 closure sequence.

| Project | Sampled later objects | Interpretation |
|---|---|---|
| Chananya staging | 19 of 19 present | Schema appears manually advanced beyond its recorded ledger; run the guarded fingerprint recovery before adding entries |
| Jitarsa staging | 19 of 19 present | Schema appears manually advanced with no recorded ledger; reconstruct only after full guarded verification |
| Current production | 0 of 19 present | Schema is genuinely older; migrate only through the complete ordered promotion process, never by ledger repair |

Object presence is not a fingerprint attestation. It only determines whether
the next action is guarded verification/repair or ordered migration replay.
Use `supabase/manual/migration_provenance_probe_20260901.sql` to reproduce the
probe.

## Required execution order

1. Generate the exact-revision guarded ledger recovery SQL from the repository.
2. Run its verification phase against Chananya staging and retain the output.
3. Repair the Chananya staging ledger only if every schema, ACL, owner and
   fingerprint precondition passes.
4. Repeat independent verification for Jitarsa staging; do not infer equivalence
   from Chananya.
5. Promote the trigger ACL candidate into the ordered migration chain.
6. Apply it to Chananya staging only, then re-run inventory and Security Advisor.
7. Run authenticated role regression, negative RPC and cross-tenant tests.
8. Repeat on Jitarsa staging after its ledger is verified.
9. Submit the exact remediated commit and evidence to an independent assessor.
10. Treat production as an ordered upgrade through the existing promotion gate.

## Evidence queries

- `supabase/manual/security_definer_exposure_inventory.sql`
- `supabase/manual/migration_provenance_probe_20260901.sql`

Retain the project reference, execution timestamp, exact source revision,
result, and reviewer identity with every run.
