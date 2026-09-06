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

These are aggregate discovery results, not a complete live ACL manifest. The
reviewed 45-migration replay has 146 public routines and 140 `SECURITY DEFINER`
routines, while Chananya reported 147 and 141 respectively. Of Chananya's 81
anonymous-executable definers, 11 are executable trigger functions and 17 are
the named browser-RPC drift tuples already retained in this branch. The
remaining **53 ordinary anonymous-executable definers**, plus the live-only
147th routine, have not yet been identified and classified row by row. No ACL
candidate or ledger repair may be authorized from the aggregate counts or the
22 known browser tuples.

Canonical replay also exposed a twentieth ordinary browser function that the
earlier tuple list did not cover:
`public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)`.
It is `SECURITY INVOKER`, is called by `opd-workflow.js`, and inherits default
`PUBLIC EXECUTE` even though its migration also grants `authenticated` directly.
This is repository-derived evidence, not a claim about the complete live state.

## Chananya trigger-function classification

Chananya staging currently contains 23 non-internal public trigger functions.
Sixteen are executable by at least one Data API runtime role. Trigger functions
are invoked by PostgreSQL through trigger bindings and are classified as
internal implementation functions, not supported RPC endpoints.

An EXECUTE ACL is privilege evidence, not proof that PostgREST exposes a callable
RPC route. Its schema cache excludes functions returning `trigger`. The trigger
candidate hardens internal function ACLs; ordinary SECURITY DEFINER RPCs still
need their own access-control review.

The projected migration design under review in this draft branch would:

- revoke function execution from `PUBLIC`, `anon`, `authenticated`, and
  `service_role` for every non-internal public trigger function;
- leave trigger bindings and ownership unchanged;
- pin `public.set_updated_at()` to `pg_catalog, public`;
- reject any trigger on a public relation or `auth.users` that binds a
  non-`public` function, and require every reviewed function owner to be
  exactly `postgres`;
- freeze executable function semantics (arguments/result, language, security
  and execution flags, costs, defaults, body/binary/SQL body and configuration)
  and full semantic trigger bindings before and after the intended change;
- fail closed if any Data API runtime role retains trigger-function execution;
- remain outside `supabase/migrations` until provenance is reconciled.

Both manual ACL files are deliberately inert in this revision. The first
executable statement inside each sole mutation DO raises
`CNYOS_*_LIVE_PUBLIC_ROUTINE_MANIFEST_NOT_REVIEWED`, before every `REVOKE` or
function alteration. This is a design-review scaffold, not staging execution
authorization.

## Migration-ledger divergence

| Project | Recorded migration state | Decision |
|---|---|---|
| Chananya staging | 32 entries, ending at `202608311800_owner_subscription_control` | Observe/classify the complete live ACL manifest first; the current repair is blocked; do not replay migrations blindly |
| Jitarsa staging | No migration-ledger entries returned | Establish an independent live baseline after Chananya; no Jitarsa repair exists; do not replay migrations blindly |
| Current production | No migration-ledger entries returned | Older schema; no ledger repair or direct patch; production remains blocked |

The repository migration contract expects 45 ordered, fingerprinted migration
files, including the 2026-09-01 owner-control, backup, service-role, and
subscription-closure sequence.

## Read-only provenance probe

The probe sampled nine later functions, three later relations and seven later
columns from the 2026-09-01 closure sequence.

| Project | Sampled later objects | Interpretation |
|---|---|---|
| Chananya staging | 19 of 19 present | Schema appears manually advanced beyond its recorded ledger; observe and classify the complete live ACL manifest before any later reviewed fingerprint recovery |
| Jitarsa staging | 19 of 19 present | Schema appears manually advanced with no recorded ledger; establish its independent baseline after Chananya before proposing reconstruction |
| Current production | 0 of 19 present | Schema is genuinely older; migrate only through the complete ordered promotion process, never by ledger repair |

Object presence is not a fingerprint attestation. It only distinguishes a
possible later guarded recovery path from ordered migration replay; the current
next action is complete read-only observation and independent classification.
Use `supabase/manual/migration_provenance_probe_20260901.sql` to reproduce the
probe.

## Required execution order

1. Keep PR #36 draft and unapproved. Do not merge it: this repository's `main`
   branch automatically publishes to Netlify, so a merge is a production touch
   even when it contains no database migration.
2. Obtain an independent PR #36 security review of trigger-function and browser-RPC
   ACL revocation, the verifier's enforced read-only transaction, and repair
   atomic failure/rollback behavior. Jaoball's earlier approval applies to PR #38;
   it is not PR #36 sign-off unless Jaoball separately validates all three areas.
3. Review exact-head CI, then run
   `public_routine_acl_inventory_read_only.sql` from that exact PR branch in a
   fresh direct `psql -X` process against **Chananya staging only**. This observer
   is a repeatable-read, read-only discovery artifact. It always reports
   `authorization=false` and `production_eligible=false`; its output is not a
   passing gate.
4. Stop and independently classify the observer's complete routine semantics,
   raw ACLs, effective role access, public-schema ACL, connected runtime-role
   graph, extension ownership and function default ACLs. Check the exact live
   rows/counts/byte lengths/SHA-256 values into a new PR #36 commit, then repeat
   independent review and exact-head CI. The 22 retained tuples are only a known
   subset and cannot substitute for this step.
5. The current Chananya **pre-reconciliation** verifier may be generated for
   review, but it is known-subset diagnostic evidence with status
   `CNYOS_CHANANYA_PRE_RECONCILIATION_KNOWN_ACL_SUBSET_MATCHED_NOT_AUTHORIZED`;
   it is not a closed-world preflight and cannot enable repair. After step 4,
   update the generator to require the complete reviewed live manifest and emit
   a distinct complete-manifest status, then repeat independent review and
   exact-head CI before running that new verifier directly from the PR branch.
   Merging remains unnecessary.
6. Enable and run its matching write-capable repair only in a later reviewed
   commit whose exact live manifest is complete. Every repair mode generated by
   the current revision is intentionally blocked before every write. Any
   eventual result still means ledger reconciled with ACL remediations pending;
   it is not readiness or production eligibility.
7. Establish, reconcile and review Jitarsa independently after Chananya. Until a
   separate Jitarsa baseline exists, CI publishes no Jitarsa verifier or repair
   artifact. Its disposable PostgreSQL 17 test still proves that an unpinned
   configuration is labeled target-unverified/non-authorizing, but that test
   output is not Jitarsa staging evidence.
8. Promote the reviewed ACL candidates, including approved function-default-ACL
   closure, into a separate ordered-migration PR only
   after both ledgers are independently reconciled; preserve the 45 historical files.
9. Apply that chain to Chananya staging, then run the **strict post-remediation**
   verifier, inventory, Security Advisor, authenticated role regressions, negative
   RPC checks and cross-tenant tests.
10. Repeat the independently approved regression process on Jitarsa staging.
11. Submit the exact remediated commit and evidence to an independent assessor.
12. Only then authorize the normal production gate and production deployment.

## Evidence queries

- `supabase/manual/security_definer_exposure_inventory.sql`
- `supabase/manual/public_routine_acl_inventory_read_only.sql`
- `supabase/manual/migration_provenance_probe_20260901.sql`

Retain the project reference, execution timestamp, exact source revision,
result, and reviewer identity with every run.

## Verification artifact and evidence contract

CI retains four deliberately distinct files plus `SHA256SUMS`:

- `public-routine-acl-inventory-read-only.sql`;
- `cnyos-staging-pre-reconciliation-verification-only.sql`;
- `cnyos-staging-pre-reconciliation-guarded-repair.sql`;
- `cnyos-staging-strict-post-remediation-verification-only.sql`.

There is no Jitarsa verifier or repair artifact until an independent Jitarsa
baseline exists. The repair generator also rejects every non-Chananya
target in this revision; enabling Jitarsa requires a separate reviewed baseline
and source change. The disposable native harness exercises target-unverified
generation only against an ephemeral database. Check the workflow's exact head
SHA and every downloaded
checksum before use. Every verifier and repair generator rejects a migration
manifest unless its count and ordered version/name/SHA-256 digest exactly match
the reviewed 45-file chain.

The public-routine observer is intentionally separate from the closed-world
verifier. It takes operator-supplied exact source revision and project label as
metadata, reports rather than authorizes the observed server/database identity,
captures all public routines (including extension-owned routines), and retains
full review rows plus independent and composite digests. It runs in a
REPEATABLE READ, READ ONLY transaction, captures its JSON in that snapshot,
performs a literal `ROLLBACK`, verifies release of the shared advisory lock and
only then emits one `CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED` JSON row. It never
emits `PASSED` or `READY`.
The fresh-session detector intentionally allocates two permanent transaction
IDs through adjacent autocommit `pg_current_xact_id()` probes before the
read-only snapshot. That expected accounting effect changes no application row,
catalog or ACL. The observer forces UTF-8 psql output and pins the supported
catalog-deparsing and JSON-text output GUCs before hashing. Exact-head CI executes
the unmodified file with PostgreSQL 17 `psql` against PostgreSQL 17 under hostile
caller GUCs and client encoding, including a non-ASCII routine, missing or
malformed metadata, outer-transaction refusal, same- and cross-session lock
contention, and injected post-acquisition failure. It verifies exact single-line
LF output, empty success stderr, an exact 0→1→0 advisory-lock lifecycle,
error cleanup and no-mutation state. The observer refuses before acquisition if
its session already holds the key and emits evidence only after both a successful
unlock and proof of zero remaining same-session holds.
For verification, use a fresh trusted `psql` session with `-X` and
`--set=ON_ERROR_STOP=1 --file=<target>-verification-only.sql`. Select the staging
connection through the operator's existing credential mechanism and independently
confirm its exact project reference and origin. A config-bound project reference
labels the intended target; it does not attest the live connection endpoint.

The psql verifier requires `AUTOCOMMIT=on`, refuses and rolls back an existing
caller transaction, pins the server-observed database plus `session_user` and
`current_user` to `postgres`, and pins `search_path` before all identity/XID
probes. It rejects a same-session pre-held advisory key and tries the shared
gate without waiting before it starts a REPEATABLE READ, READ ONLY transaction,
where the path is pinned locally again. It verifies both transaction settings, applies
statement/lock timeouts, reads schema and privilege catalogs and staging
preconditions, and captures its evidence inside that same snapshot. It then
performs a literal `ROLLBACK`, checks both that the session advisory lock was
released and that zero same-session holds remain, and only afterward emits the
`migration_ledger_verification_evidence` JSON row
with `verification_transaction_rolled_back=true` and
`advisory_lock_released=true`. It emits no success NOTICE inside the transaction,
and before catalog hashing or serialization it pins UTC, ISO/YMD dates,
PostgreSQL interval formatting, `extra_float_digits=3`, hexadecimal bytea output,
`quote_all_identifiers=off`, and `standard_conforming_strings=on`. It does not
call application healthchecks, and does not write the ledger. The reader
requirement avoids evaluating application RLS policies during its precondition
reads. Every verifier observes
`pg_control_system().system_identifier`; the exact CNYOS pre-reconciliation and
strict artifacts require `7666007964130682852`, while Jitarsa strict only reports
the observed identifier until an independent Jitarsa cluster baseline is reviewed.
A wrong CNYOS cluster fails before evidence capture or output.

Current Chananya strict diagnostic evidence uses status
`CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_NOT_AUTHORIZED`.
Unpinned Jitarsa uses
`CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_TARGET_UNVERIFIED_NOT_AUTHORIZED`
and sets `target_identity_verified=false`. Both require the
reviewed 23-function trigger inventory, zero non-owner raw ACL tuples and zero
effective `anon`/`authenticated`/`service_role` execution on every bound trigger
function, plus exact `public.set_updated_at()` search path
`pg_catalog, public`, but neither authorizes reconciliation. Every current
verifier mode sets `authorization=false`,
`ledger_reconciliation_authorized=false`,
`live_callable_acl_inventory_complete=false`, `ledger_reconciled=false`, and
`production_eligible=false`.

Exact-head CI executes a separate PostgreSQL 17 verifier harness for wrong
Chananya system identity; seeded-write refusal under `AUTOCOMMIT=off`, an outer
transaction and `--single-transaction`; same-session pre-held and external lock
contention; a test-bound Chananya strict diagnostic; and the exact Jitarsa
target-unverified diagnostic. It requires one non-authorizing post-rollback JSON
object on successful fixtures, an unchanged database snapshot and zero residual
advisory locks. The ephemeral test binding is never staging evidence, and native
pre-reconciliation success remains outside this harness.

The Chananya known-subset verifier evidence instead uses status
`CNYOS_CHANANYA_PRE_RECONCILIATION_KNOWN_ACL_SUBSET_MATCHED_NOT_AUTHORIZED` and
sets `authorization=false`, `live_callable_acl_inventory_complete=false`, and
`ledger_reconciliation_blocked_pending_live_callable_acl_inventory=true`. It is
restricted to project `hsmnjwxurlmsizndjlun`, the exact Supabase origin,
deployment/clinic identity, a full 40-character artifact source revision and the
reviewed 45-entry migration manifest. Its known-evidence bundle digest is
`2f4ec29006a5a2b3a0e3b2d7aa9018861bee5153b60887c625d6a46d2516a733`.
That digest binds the earlier observation head `79750ef1f5bb3baa82f57687276b6efb1a2d345c`,
the exact **known subset** of 22 browser-RPC tuples (17 `anon`, five
`service_role`), the exact
23-function trigger inventory/state and owners, its exact 62 raw ACL tuples,
the executable function-semantics snapshot and the full 168-row trigger-binding
snapshot observed at `2026-09-06T16:47:15.312545Z`. The verifier pins PostgreSQL
major 17 and UTF-8. The pre-reconciliation function-semantics payload is 21,183
bytes with SHA-256
`4c92389f247e80c27c63721eff19f321ed538c8e70d616df5aa36e193cb2eb0b`;
the projected strict payload, whose only approved semantic change is
`set_updated_at()`'s pinned `search_path`, is 21,213 bytes with SHA-256
`07535c64e7607d8cc9bc34b197a40e3923f4f56df84262d041d56541b1890737`.
The canonical binding payload is 46,998 bytes with SHA-256
`9430970d3b25cbe3d5d4ab704740e62ce5a6864d9a804a732ed6f8919523fe54`.
Its scope is the union of every non-internal trigger on a public relation, every
trigger on `auth.users`, and every binding to a public function. Each
bytewise-ordered binding row records semantic relation/function identity, trigger
name, enablement/type, ordered update-column names, arguments, constraint timing,
WHEN expression, transition tables and semantic constraint/index/parent links.
Physical attribute numbers are deliberately represented by their ordered column
names so equivalent rebuilt schemas do not drift solely because of storage layout.
Every known-subset ACL tuple must be direct, owner-issued, non-grantable
`EXECUTE`; missing, additional, inherited-only, PUBLIC/rogue, grant-option and
non-owner-grantor variants fail. This does not classify the unexplained live
ordinary-function exposure described above. Every listed browser function must remain owned exactly by
`postgres` before and after mutation, so a rogue owner cannot mint an otherwise
matching ACL matrix. Owner/body/flag drift, foreign-schema bindings, equal-count
swaps and other binding-definition drift also fail.

Treat the current known-subset verifier evidence as non-authorizing diagnostic
evidence only. A later complete verifier bundle can be accepted for ledger
reconciliation only when the observer's exact live manifest has been reviewed
and all of these are present:

- The workflow run, full source SHA and artifact checksum match the reviewed head.
- The independently verified connection target, clinic ID/code and deployment
  match the JSON evidence's expected values.
- The complete client transcript contains the literal successful `ROLLBACK`, no
  verifier success NOTICE, and exactly one
  `migration_ledger_verification_evidence` JSON row emitted afterward with
  `verification_transaction_rolled_back=true` and
  `advisory_lock_released=true`.
- The client reports no errors and exits with status zero.
- Execution time and reviewer identity are retained with that transcript.

The post-rollback JSON row is the verifier's only success-shaped output; a failed
guard, rollback, or advisory unlock cannot emit it. Staging healthchecks,
migration-ledger reconciliation and authenticated/negative/cross-tenant
regressions remain separate gates. Never substitute the write-capable
guarded-repair artifact for read-only verification.

Every repair artifact generated by this revision—including strict—is
deliberately non-executable. Each raises
`CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED` inside both its guard
and its sole mutation block, before any temp-table DDL, ledger DDL/DML,
application healthcheck, repair receipt or success evidence. The duplicate
structural refusal prevents a client that recovers the guard error through a
savepoint from continuing into writes. Only a later independently reviewed
commit containing the complete all-routine semantic/ACL, extension and
function-creator default-ACL manifest may replace those refusals.
Simply deleting the refusals is not authorization: the later change must bind
the reviewed live/default-ACL digests into its gate token and evidence, replace
the current non-authorizing/incomplete-inventory fields, freeze or revalidate
catalog/role/default-ACL state through ledger commit, and include those
prerequisites in post-commit proof. It requires a new independent review and
exact-head CI.

After that later authorization, the guarded repair is executable only by a fresh, direct/session-affine `psql -X`
process with `AUTOCOMMIT=on` and `ON_ERROR_STOP=1`. Do not use
`--single-transaction`, `ON_ERROR_ROLLBACK`, a transaction pooler, SQL Editor,
driver wrapper or pre-existing transaction. Before `BEGIN`, the artifact refuses
an outer transaction; a misuse path first rolls it back and then raises a hard SQL
error while its own `ON_ERROR_STOP=1` is active, so direct and nested callers exit
nonzero and cannot reach a tail sentinel. No refusal or post-commit proof depends
on `\q`/`\quit` or a numeric quit argument. Behind the unconditional live/default
ACL blocker, every write-capable ACL phase first requires the exact reviewed 45-entry
ordered version/name/SHA-256 manifest; canonical syntax and cardinality alone are
insufficient.

The psql preflight also requires the exact direct connection tuple
`db.hsmnjwxurlmsizndjlun.supabase.co:5432`, database/user `postgres`. The SQL
transaction independently reads `pg_control_system()` and fails unless its
observed `system_identifier` is the reviewed Chananya cluster identity
`7666007964130682852`. Config-derived project/origin/host values are emitted only
as `expected_*`; they are never represented as observations. Evidence separately
records the observed server system identifier, psql connection parameters,
server address/port, current database/user and TLS state. The system identifier is
the enforceable server-side cluster binding. Psql special variables remain a
client-process trust boundary and can be rewritten by a hostile wrapper, so direct
checksum-verified `-X --file` execution and a retained transcript are mandatory;
server addresses and TLS ciphers are operational observations, not immutable pins.
The psql preflight sets `search_path` to `pg_catalog, pg_temp, public` before
connection, identity, XID, nonce, and lock probes; both the write transaction and
post-commit proof set that same path locally before DDL or proof expressions.
Both transactions also pin UTC, ISO/YMD dates, PostgreSQL interval formatting,
`extra_float_digits=3`, hexadecimal bytea output,
`quote_all_identifiers=off`, and `standard_conforming_strings=on` before catalog
hashes or serialized evidence are computed.

The envelope creates a fresh per-invocation UUID and clears the prior committed
UUID and XID before `BEGIN`. It removes any stale temporary marker inside the
guarded write transaction and keys its new marker to both that UUID and the
repair transaction's actual top-level `pg_current_xact_id()`. The new marker is
`ON COMMIT DROP`, making successful cleanup part of the same transaction. The repair
re-reads the XID before evidence creation and inserts the evidence atomically into
`supabase_migrations.cnyos_migration_ledger_repair_receipts`. The locked-down,
`postgres`-owned registry has UUID primary-key replay protection, unique gate
token/XID binding, and exact PostgreSQL 17 definitions for three validated checks:
`cnyos_repair_receipt_gate_token_check` requires a 64-character lowercase
hexadecimal gate token; `cnyos_repair_receipt_xid_check` requires a numeric repair
XID; and `cnyos_repair_receipt_evidence_check` requires its entire JSON-object and
column-binding conjunction to evaluate `IS TRUE`, so missing or JSON-null binding
keys cannot pass as SQL `NULL`. The
registry also has an exact identifying comment and no non-owner ACL. Same-named
permissive or older nullable checks therefore fail before any ledger write. Both
durable relations are locked and required to have exact persistent ordinary-table,
column, default, constraint, index, owner, ACL, RLS, inheritance, trigger and rule
catalog state before mutation; `committed_at` has the sole exact
`clock_timestamp()` default. Canonical
SHA-256 comments on the 45 migration rows remain
provenance evidence only and are not nonce replay receipts. Deferred constraints
are forced immediate and the exact ledger is rechecked after receipt insertion.
After literal `COMMIT` performs that automatic cleanup, a new read-only proof
transaction begins with no intervening DDL and takes `SHARE` locks. The proof then revalidates both the durable
receipt and all 45 committed ledger rows before rollback, advisory unlock, and
JSON output; no DDL runs between that proof and evidence emission.
A failed guard, ordinary abort, savepoint recovery, deferred commit failure, stale
marker, replayed UUID, mismatched XID, malformed receipt or committed-ledger drift
therefore cannot launder a pre-existing ledger into a success-shaped result. Accept repair evidence only with the expected
status, matching UUID/XID and trigger digests, a literal successful `COMMIT` (not
`ROLLBACK`), no errors and zero client exit.

Exact-head CI must pass `tests/migration-ledger-psql-e2e.mjs` with real `psql` and an ephemeral
PostgreSQL 17 server. The supplied pre-reconciliation artifact is regenerated
byte-for-byte and directly covers wrong-cluster and wrong-client-connection
refusal. Its test-bound copy differs only in the five reviewed system-identifier
occurrences; its runtime reaches the guard live-inventory blocker and proves a
nonzero exit, no success output, no durable mutation and no leaked advisory lock.
CI statically asserts both blockers, including the mutation-block backstop. A
native savepoint-recovery copy changes only client error controls and a terminal
test-only abort, reaches both retained source blockers, and proves no durable
write or success output; PGlite independently covers both blockers. All
executable success and atomic-failure fixtures use a separately generated strict
artifact explicitly bound to the ephemeral cluster with exactly the two source
blockers removed. No generated or retained artifact exposes that bypass. A
separately labeled savepoint adversary injects a controlled mid-repair
exception. Another native fixture creates a deferred foreign-key violation only
after the repair DO and therefore fails at the real `COMMIT`.
Assertions cover per-run UUID, numeric top-level XID, expected/observed identity,
45 canonical ledger rows with SHA provenance, locked durable repair receipts,
same-nonce/stale-state rejection, deferred failure and no success JSON on failure.
These copies do not prove byte-identical production
execution against live staging. The current local Codex host has no `psql`, local
server, Docker or Podman, so real-client execution is CI-only and local validation
uses the PGlite transactional contract.
The reserved transitional repair status is
`CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING`;
its evidence keeps `acl_remediation_pending=true`, `ledger_reconciled=true` and
`production_eligible=false`. The current blocked artifact cannot emit that
status. No pending state is called `READY`.

Both manual ACL candidates keep their projected changes and checks in one
atomic DO statement, whose first executable statement is an unconditional
live-manifest refusal. They emit no `*_CHECKS_PASSED` notice or other
success-shaped output. Fixture-only tests remove that one refusal to validate
projected semantics and rollback; those tests do not authorize staging use.
Each manual file is a fresh-session-only psql program: it forces
`ON_ERROR_STOP`, refuses `AUTOCOMMIT=off`, detects an existing caller transaction
with two adjacent XID probes, and rolls that transaction back before aborting.
This prevents its tail `COMMIT` from committing unrelated caller writes even
under savepoint-continuation wrappers. PostgreSQL 17 CI runs both exact files and
seeded-write adversaries for explicit outer transactions and
`--single-transaction`; it also covers same-session pre-held-key refusal and a
continued source-blocker error path. Each candidate's exception handler unlocks
before rethrow, while the terminal release rejects either a failed unlock or any
remaining same-session hold. CI then verifies no durable/ACL mutation and no
leaked advisory lock. The later ordered migration must replace this psql wrapper with a
separately reviewed migration-native transaction envelope.
The browser-RPC candidate additionally requires the exact raw ACL matrix:
expected grants must be direct, non-grantable and owner-issued, and no other
non-owner ACL tuple may remain. Its projected canonical strict effective sets
are exactly 0 `anon`, 70 `authenticated`, and 75 `service_role` routines, and it
includes the twentieth treatment-session function. Both candidates pin their
transaction-local catalog search path before privileged inspection or mutation.
The eventual ordered migration must also revoke default `PUBLIC EXECUTE` for
every independently approved public-function creator and ensure runtime roles
cannot `CREATE` in `public`; closing only today's function ACLs is insufficient.
These candidates remain unapplied source proposals in this workstream.
