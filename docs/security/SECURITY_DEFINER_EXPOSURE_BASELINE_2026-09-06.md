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

An EXECUTE ACL is privilege evidence, not proof that PostgREST exposes a callable
RPC route. Its schema cache excludes functions returning `trigger`. The trigger
candidate hardens internal function ACLs; ordinary SECURITY DEFINER RPCs still
need their own access-control review.

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

1. Review the source and exact-head CI before running any database SQL. Generate
   the separate verification-only artifact from that full 40-character revision.
2. Run only that read-only artifact against Chananya staging and retain the
   evidence described below. A schema guard pass does not reconcile the ledger.
3. Repair the Chananya staging ledger only if every schema, ACL, owner and
   fingerprint precondition passes.
4. Repeat independent verification for Jitarsa staging; do not infer equivalence
   from Chananya.
5. Review both ACL candidates and promote them into the ordered migration chain
   only after independent ledger reconciliation; preserve the 45 historical files.
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

## Verification artifact and evidence contract

CI retains separate `<target>-verification-only.sql` and
`<target>-guarded-repair.sql` files plus `SHA256SUMS` for both staging tenants.
Check the workflow's exact head SHA and the downloaded checksums before use.
For verification, use a fresh trusted `psql` session with `-X` and
`--set=ON_ERROR_STOP=1 --file=<target>-verification-only.sql`. Select the staging
connection through the operator's existing credential mechanism and independently
confirm its project reference. The artifact's configured `project_ref` labels
the expected target; it does not attest the actual connection endpoint.

The verifier starts a REPEATABLE READ, READ ONLY transaction, requires a
superuser/BYPASSRLS reader, verifies both transaction settings, applies
statement/lock timeouts, reads schema and privilege catalogs and staging
preconditions, and ends with ROLLBACK. It does not call application healthchecks
or write the ledger. The reader requirement avoids evaluating application RLS
policies during its precondition reads.

`CNYOS_STAGING_SCHEMA_GUARD_PASSED` is a provisional NOTICE emitted inside the
successful guard. Accept an evidence bundle only when all of these are present:

- The workflow run, full source SHA and artifact checksum match the reviewed head.
- The independently verified connection target, clinic ID/code and deployment
  match the NOTICE's expected values.
- The complete client transcript contains exactly one guard-pass NOTICE, the
  final ROLLBACK completion, no errors, and a zero client exit status.
- Execution time and reviewer identity are retained with that transcript.

A NOTICE alone is never completion evidence. Error-recovery clients receive no
guard-pass NOTICE if the guard fails. Staging healthchecks, migration-ledger
reconciliation and authenticated/negative/cross-tenant regressions remain
separate gates. Never substitute the write-capable guarded-repair artifact for
read-only verification.

Both manual ACL candidates now perform changes and checks in a single atomic
DO statement. Their `*_CHECKS_PASSED` NOTICE is also provisional: an authorized
future apply requires a successful COMMIT and a zero-error client result.
An error must not be interpreted as closure even if the client continues.
The browser-RPC candidate additionally requires the exact raw ACL matrix:
expected grants must be direct, non-grantable and owner-issued, and no other
non-owner ACL tuple may remain. Both candidates pin their transaction-local
catalog search path before privileged inspection or mutation.
These candidates remain unapplied source proposals in this workstream.
