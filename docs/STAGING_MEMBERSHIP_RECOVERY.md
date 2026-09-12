# Staff-membership recovery candidate

This is a local implementation candidate based on `9de6cd2`, not a deployed
database change, independent human approval, or evidence that staging is ready.
The verifier's old unconditional `finally` reactivation has been replaced with
a version- and receipt-bound proof. PR #36's branch is unchanged.

## Implemented boundary

`supabase/manual/staff_membership_recovery_candidate.sql` remains outside the
ordered migration directory and aborts its transaction before any DDL/DML when
run directly. The local contract test loads only the explicitly marked definition
region into a new in-memory PGlite database. This is not an activation mechanism.

The proposed database contract adds:

- A UUID `state_version` to each membership, refreshed by an invoker trigger on
  every ordinary insert/update, including legacy writes and attempted reuse of
  an earlier UUID. Deleting/recreating a membership therefore gets a new token.
- `admin_read_staff_membership_state(uuid,uuid)`, requiring the authenticated
  actor's current clinic and governance capability.
- `admin_transition_staff_membership(uuid,uuid,jsonb,uuid,text,uuid)`, which
  suspends from an exact expected state or restores from the same actor's
  confirmed suspension receipt. It does not provide arbitrary activation.
- An owner-controlled, RLS-enabled receipt table with no runtime-role table
  privileges. The same actor/request ID and payload return the same historical
  receipt without repeating a mutation or audit event. Changed payloads fail.

The transition locks profiles in UUID order before membership, uses
`FOR NO KEY UPDATE` to avoid blocking audit FK key checks, and rechecks the
actor's governance boundary. Suspensions of self, clinic owner/admin or system
admin/super-admin targets are refused. Restoration never rewrites role columns
or selects a different primary clinic; changed state or a new primary causes a
conflict, with all writes rolled back. Receipt and audit creation belong to the
same transaction as the membership change.

All three new functions use `search_path=pg_catalog,pg_temp`. The trigger is
invoker-only with no runtime EXECUTE grants. The two RPCs grant EXECUTE only to
`authenticated` and check actor/clinic/governance inside the function. Existing
helper functions, role inheritance, table policies and function-creator defaults
must still be reviewed in the actual target; these additions do not remediate
the outstanding PR #36 ACL/search-path findings.

`scripts/staging-membership-proof.mjs` is a credential-free injected helper used
by `scripts/verify-authenticated-staging.mjs`. It verifies initial access, sends
an exact idempotent suspension, checks an explicit replay and existing-session
denial, and restores only from a validated receipt. Each mutation/replay phase
permits at most two identical transmissions. It never changes the request ID,
rebases to current state, or calls the legacy unversioned RPC. A failed denial
check still attempts the exact confirmed restoration, but never reports UAT
success. Missing v2 RPCs fail before suspension; there is no legacy fallback.

On a fully successful run it returns a `closureConfirmation` with
`schemaVersion: 1`, `componentVersion: 1.0.0-candidate.1`, `scope:
staff-membership-uat`, and `status: verified`. Its `requestId` is the
validated ON receipt request ID; it also carries the OFF and ON request IDs,
before/suspended/restored state versions, and both receipt completion
timestamps. This is a local confirmation of the same restore operation, not a
third database mutation or a clinical-encounter closure. No closure
confirmation is returned after an unconfirmed or malformed receipt, process
failure, failed restore, or failed denial assertion. Membership-UAT closure
must not be interpreted as reopening or closing a clinical encounter.

The candidate component version is `1.0.0-candidate.1`. Copyright ownership
is awaiting the user's holder-name confirmation in [COPYRIGHT.md](../COPYRIGHT.md).
The [version index](../version-index.json) and [index guide](VERSION_INDEX.md)
link the component, tests and documentation without claiming a source hash,
licence change, or release authorization.

## Actual local checks

```sh
npm run check:membership-recovery
node tests/staging-safety-contract.mjs
node tests/staging-subscription-proof-contract.mjs
node --experimental-loader=./tests/plain-mts-loader.mjs tests/owner-control-contract.mjs
```

The membership suite runs 25 tests: direct-candidate refusal, same-request
replay, stale versions, no-op legacy writes, deletion/recreation, role changes,
primary-clinic conflicts, full transaction/audit failure rollback, receipt ACLs,
actor/clinic denials, privileged-account exclusions and the integrated helper
with lost/malformed responses. Added closure regressions cover lost ON replies,
malformed ON receipts, mismatched restore references and invalid/missing request
IDs before I/O. The version-index contract runs after the membership suite.
PGlite uses minimal synthetic auth/helper/table
fixtures; this does not validate the complete deployed RLS or JWT-service graph.

## Required before any live activation

| area | verdict | evidence | limit |
| --- | --- | --- | --- |
| Local SQL/helper implementation | PASS in bounded tests | 25 PGlite/helper cases; version-index and existing staging/subscription contracts | Not native multi-session or live staging evidence |
| Separate Astra technical review | PASS for bounded closure/index changes | Read-only reviewer ran all 25 membership tests, version-index and staging-safety contracts against the dirty checkout based on `9de6cd2`; no material finding confirmed | Not a reapproval of the SQL candidate, native/platform evidence, durable crash recovery, or independent human approval; root corrected the noted documentation drift |
| Ordered migration/promotion | NOT DONE | The original ordered migration chain is unchanged; candidate is unconditionally blocked | A separately reviewed migration must be created with the Supabase CLI before promotion |
| Native concurrency and platform review | PARTIAL: 8 native functional cases passed | [PostgreSQL 17.11 checkpoint](STAGING_MEMBERSHIP_NATIVE_RECOVERY.md) proves bounded multi-session replay/conflict, timeout and disconnect behavior with a non-superuser fixture owner | Actual legacy RPC writers, complete auth/RLS/default-ACL/trigger graph, hosted behavior and durable runner recovery remain unverified |
| Cross-process recovery | NOT COMPLETE | Durable server receipts and stable supplied IDs are supported | The CLI still generates request IDs in memory; a protected runner must durably record IDs, original state, receipts and intended restore before mutation, with resume/watchdog handling |
| Managed staging and production | BLOCKED | Existing controller, review, broker and recovery-baseline gates remain unchanged | No migration, provisioning, UAT, merge or deployment is authorized by this file |

If both transmissions lose their responses, the state may already be changed.
The helper stops without a blind inverse mutation. A future protected recovery
worker must retrieve the exact receipt with the retained request payload, then
attempt only the receipt-bound restore. A changed actor or target boundary is
not permission to override the conflict; administrative recovery needs its own
reviewed procedure. Receipt retention and deliberate cleanup require an owner
decision; deleting receipts while retries are possible is not safe.

Before promoting these new objects, update the reviewed routine/trigger/default
ACL inventory and source closure for the new exact commit. Prior `dc6c8c7`
sign-offs, manifests and live observations do not cover this candidate. Keep
Chananya/Jitarsa ledger decisions independent and do not replay initialization.

The original membership baseline was implemented by the root after repeated
Luna delegation failures and received a bounded Astra technical review. The
closure-confirmation follow-up was implemented by a Luna worker, with root
integration and version/copyright metadata work after additional delegation
limits. That historical review is not approval of this follow-up; the fresh
review state is recorded above. No Ollama security approval is claimed.

References: [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)
and [secure definer functions](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).
