# Authenticated staging release gate

Status: unprivileged candidate harness present; protected deployment controller
and execution evidence pending. This runbook does not authorize a staging or
Production deployment and does not mark the commercial release gate as passed.

The public-routine remediation also requires the
[Chananya staging ACL maintenance protocol](security/CHANANYA_STAGING_ACL_MAINTENANCE_PROTOCOL.md).
That protocol is non-authorizing and keeps PR #36 draft, production untouched,
and the hosted `supabase_admin` exception explicitly owned.

The workflow in this repository is deliberately unprivileged. It runs offline
contracts and emits database-locked static and Function inputs, but it has no
GitHub Environment, Netlify token, service-role key, staging password, or
tenant-config secret. A candidate branch must never define the job that receives
deployment credentials: it could delete its own checks and use the credential
directly.

The credentialed publisher must live on the protected default branch of a
separate deployment-control repository (or an already existing independently
protected controller). The candidate commit is input data only. That controller
must rehash the artifact, validate two out-of-band signatures, publish only to
the fixed cnyos staging project, and run the authenticated checks described
below. This separate controller is required because merging a bootstrap workflow
into this repository's `main` branch would itself trigger a Production Netlify
deployment.

## Isolation requirements

Before any run, create a staging boundary with all of the following:

- a Supabase project that is not the Production project;
- a Netlify site/origin that is not the Production site;
- a deployment ID containing `staging`, `stage`, `nonprod` or `test`;
- a clinic code and QR issuer that differ from Production;
- synthetic accounts and records only;
- the complete ordered migration set applied to staging;
- OAuth/LINE callback allowlists containing only the staging callback origins used for testing.

The command-line guard requires an explicit Production config denylist for the licensed customer. It rejects the Production Supabase origin, Production site, Production clinic code, Production QR issuer, non-staging deployment IDs, HTTP origins, missing acknowledgement, and a mismatch between `STAGING_SITE_URL` and the staging config redirect origin. This prevents a white-label customer from being compared only with Chananya's target. It never prints passwords, service-role keys or session tokens.

Use `config/tenant.staging.example.json` as the public configuration template. Replace the placeholder Supabase URL, publishable key and site origin outside the repository. Apply the migrations and then generate/run the tenant bootstrap SQL against the isolated project:

```sh
npm run tenant:bootstrap-sql -- /absolute/path/tenant.staging.json
```

The bootstrap is idempotent: it creates the configured clinic UUID on a fresh database or updates that same UUID, fails on a clinic-code collision, and never re-keys the canonical clinic row seeded by the migrations. A successful run returns `CHANANYA_TENANT_BOOTSTRAP_READY` with the staging deployment and clinic identifiers.

After the clinic bootstrap succeeds, provision the 11 synthetic staging identities. Then verify that `current_access_context()` returns the staging clinic UUID/code for each identity.

### One-time migration ledger recovery

If the schema was installed manually before the Supabase CLI migration history
was initialized, do not simply mark filenames as applied or replay them blindly.
Establish object-level provenance first. For the pinned Chananya snapshot in
this workstream, do not apply a migration from PR #36 and do not perform any new
staging bootstrap or identity provisioning before the independent security
review and exact-head CI gates below pass. Bootstrap and the 11 synthetic
identities are later verifier/repair prerequisites if they are not already
present; their need must be established without treating this draft as staging
mutation authorization. Keep PR #36 draft and unapproved; merging is unnecessary
and would publish `main` to Netlify.

The initial aggregate baseline was incomplete: it implied 53 ordinary
anonymous-executable `SECURITY DEFINER` routines beyond the 17 named browser
drifts, plus one live-only public routine. Closed-world discovery and
classification are now complete for the 25-dataset observation at source
revision `831543c2d1ed36b2d8242cc82af23c83e019e7a7`. After independent design
review of the ACL, read-only and rollback controls and exact-head CI, rerun the
standalone observer from the exact current PR commit to detect drift:

```sh
psql -X --quiet --no-align --tuples-only \
  --set=ON_ERROR_STOP=1 \
  --set=AUTOCOMMIT=on \
  --set=cnyos_observation_source_revision=<exact Git SHA> \
  --set=cnyos_observation_project_label=chananya-staging \
  --file=supabase/manual/public_routine_acl_inventory_read_only.sql \
  '<direct Chananya staging connection>' \
  > /secure/path/chananya-public-routine-acl-observation.json
```

The observer is read-only discovery, not a gate. It emits one post-rollback
`CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED` record with `authorization=false` and
`production_eligible=false`. Retain its complete JSON and checksum securely;
compare every routine, raw/effective ACL, extension membership, schema
privilege, connected runtime-role edge, default function ACL, and binding with
the checked-in reviewed disposition. Any drift requires fresh independent
classification, a new exact live manifest commit, and repeated independent
review and exact-head CI before running the closed-world verifier.

The observer must also contain the closed-world
`trigger_bindings.all_non_internal` and `event_trigger_bindings.all` datasets.
Those additions are identified by artifact schema
`cnyos-public-routine-acl-observation/v2`. The same revision adds
`database_role_settings.current_database_and_global` and
`schemas.all_non_temporary.security`, plus `current_database.security`, making
25 datasets in total.
This includes bindings whose relation and handler are outside `public`; a
public-only binding query is not complete. Classify temporary-relation rows and
all non-public handlers explicitly. Every binding commits to its handler body,
catalog state, owner, raw/effective ACL, handler-schema security, the digest of
all non-temporary schema security rows, all role attributes and memberships,
current/global database-role settings, the current database owner and ACL, and
the handler's direct `pg_language` catalog row and language ACL.
An absent function-local `search_path`, `$user`, a quoted identifier, a
session-specific temporary schema, or a path without an explicit unquoted
terminal `pg_temp` remains an explicit unsafe review condition rather than an
inferred safe path. Quoted paths require manual parsing; the conservative flag
must not infer safety from commas or `pg_temp` text inside a quoted schema name.
The current complete discovery record was captured from
`831543c2d1ed36b2d8242cc82af23c83e019e7a7` after exact-head CI, reports
PostgreSQL 17.6 and system identifier `7666007964130682852`, and binds 25
datasets under artifact schema `cnyos-public-routine-acl-observation/v2`. Its
restricted raw-record SHA-256 is
`235a2c612c78367e4c2beff0243b4bc624fd6107fbdc39b1f9c0af8ae4ace27e`, its
observer-source SHA-256 is
`46a226f7ab7f0d3ee4f6062c1bc223dcdbee351d7640f86592e3614cb261a777`, and its
25-dataset composite SHA-256 is
`9a555548d810ec5bed2dc86591651ca144941687c3fd34cf8d0828708ebb9efe`.
Those hashes identify discovery evidence; they do not authorize a repair or
deployment.

The earlier 20-dataset observation captured at
`21c12683e8be06d7b42f3491274d6bb5104d6825` predates these datasets and is valid
discovery evidence only; do not bind or accept it as the complete manifest.
The direct language record does not recursively attest a procedural-language
handler binary or every database object referenced by a function body. Treat an
unexpected language or unresolved dependency as a blocker requiring separate
review rather than claiming transitive semantic closure.

Its fresh-session detector deliberately calls `pg_current_xact_id()` in two
adjacent autocommit statements. PostgreSQL therefore allocates two permanent
transaction IDs before the read-only observation snapshot; that accounting
effect is expected and does not change application rows, catalogs or ACLs. The
artifact forces UTF-8 psql output and pins the catalog-deparsing and JSON-text
settings on which its canonical payload depends, including `lc_monetary=C`,
`lc_numeric=C`, and `lc_time=C`. Exact-head CI runs the unmodified observer
with a PostgreSQL 17 `psql` client against an ephemeral PostgreSQL 17 server,
including hostile caller GUCs/client encoding, a non-ASCII routine, missing or
malformed metadata refusal, outer-transaction refusal, same- and cross-session
advisory-lock contention, and injected post-acquisition failure. It checks exact
one-line LF-terminated output, empty success stderr, an exact 0→1→0
advisory-lock lifecycle, error cleanup, and before/after no-mutation state. The
observer refuses before acquisition if its session already holds the key and
emits evidence only after both a successful unlock and proof that the session
has zero remaining holds.

CI now generates a verifier bound to the complete classified 147-routine,
141-path, 173-trigger and seven-event-trigger observation. It is read-only and
non-authorizing: complete classification is not independent approval, managed
platform risk acceptance, ledger authorization, or deployment authorization.
After independent review and exact-head CI, regenerate and execute the
verification-only artifact directly from that exact reviewed PR commit:

```sh
CLINICAL_OS_SOURCE_COMMIT=<exact Git SHA> \
node scripts/generate-migration-ledger-verification-sql.mjs \
  config/tenant.cnyos-staging.json chananya-pre-reconciliation \
  > /secure/path/cnyos-staging-pre-reconciliation-verification-only.sql

psql -X \
  --set=ON_ERROR_STOP=1 \
  --file=/secure/path/cnyos-staging-pre-reconciliation-verification-only.sql \
  '<direct Chananya staging connection>'
```

The current pre-reconciliation verifier has status
`CNYOS_CHANANYA_PUBLIC_ROUTINE_ACL_CLASSIFIED_COMPLETE_NOT_AUTHORIZED`.
It sets `live_callable_acl_inventory_complete=true` and
`classification_coverage_complete=true`, while keeping `authorization=false`,
`independent_security_review_complete=false`,
`managed_supabase_admin_exception_accepted=false`,
`ledger_reconciliation_authorized=false`,
`fresh_post_commit_observer_completed=false`, and
`ledger_reconciliation_blocked_pending_independent_review_and_authorization=true`.
Therefore even a zero-exit result is classification evidence, not repair
authorization, and cannot enable repair. The current Chananya strict diagnostic
uses
`CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_NOT_AUTHORIZED`.
Every current verifier mode carries non-authorization flags,
`ledger_reconciled=false`, and `production_eligible=false`; the strict mode does
not claim a live pre-reconciliation classification. A verifier result is valid
diagnostic evidence only when the exact artifact checksum/source commit and
independently confirmed Chananya target match, and the transcript contains one
`migration_ledger_verification_evidence` JSON row with
`verification_transaction_rolled_back=true` and
`advisory_lock_released=true`, no errors, and a zero exit. The verifier emits no
success NOTICE inside its transaction. It captures the evidence inside the same
repeatable-read, read-only snapshot, performs a literal `ROLLBACK`, checks that
the session advisory lock was released, and only then emits that JSON row. The
snapshot pins UTC, ISO/YMD dates, PostgreSQL interval formatting,
`extra_float_digits=3`, hexadecimal bytea output,
`quote_all_identifiers=off`, and `standard_conforming_strings=on` before any
catalog value is hashed or serialized. The verifier is a psql program: it requires
`AUTOCOMMIT=on`, refuses and rolls back an existing caller transaction, pins the
server-observed database, `session_user`, and `current_user` to `postgres`, and
pins `search_path` before its identity/XID probes. It rejects an already-held
same-session advisory key, tries the shared gate without waiting, and begins its
repeatable-read, read-only snapshot only after acquisition. After rollback it
requires both a successful unlock and zero remaining same-session holds before
emitting evidence. Do not run it through SQL Editor, a transaction
wrapper, or a pooled connection.
The verification guard always reads `pg_control_system().system_identifier`.
For the exact CNYOS pre-reconciliation and strict configurations it must equal
`7666007964130682852`; a wrong cluster fails before evidence capture or output.
Jitarsa strict verification records the observed value but does not pin it until
an independent Jitarsa cluster baseline is reviewed. It therefore emits only
`CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_TARGET_UNVERIFIED_NOT_AUTHORIZED`
with `target_identity_verified=false`; do not run or accept it as Jitarsa
evidence before that independent pin exists.

Exact-head CI runs a separate PostgreSQL 17 verifier harness. It covers wrong
Chananya system identity; seeded-write refusal for `AUTOCOMMIT=off`, an explicit
outer transaction and `--single-transaction`; same-session pre-held and external
lock contention; a test-bound Chananya strict diagnostic; and the exact Jitarsa
target-unverified diagnostic. Every successful fixture must emit one
non-authorizing post-rollback JSON object, preserve the database snapshot and
leave zero advisory-lock holds. The harness does not substitute its ephemeral
system identifier for staging evidence and does not natively exercise a
pre-reconciliation success path. CI publishes no Jitarsa verifier or repair
artifact before Jitarsa's independent system identity and baseline are reviewed.

The current repair generator remains useful for reviewing the write envelope,
and CI deliberately generates its blocked pre-reconciliation SQL for that
purpose, but **every phase it can generate, including strict, is intentionally
non-executable**. Each generated repair raises
`CNYOS_LEDGER_REPAIR_INDEPENDENT_REVIEW_AND_AUTHORIZATION_REQUIRED` in both the
guard and the sole mutation block before any temp-table DDL, application
healthcheck, ledger/receipt mutation or success evidence. Do not run it. The
complete classified routine, path, binding, default-ACL, observation and ledger
baseline hashes are already bound; an enabling change still requires protected
independent approval, the managed-platform exception decision, hosted
quiescence/rollback evidence, and a fresh observer. Regenerate only from that
later exact reviewed and authorized commit:

Removing the two exceptions by itself is not an enabling change. A later commit
must preserve the reviewed all-routine/default-ACL digests in its gate token and
evidence, bind the protected authorization decision, and prevent
catalog/role/default-ACL drift across verification and ledger commit with
reviewed locks or equivalent commit-time revalidation. The post-commit proof
must recheck those authorization prerequisites, not only the ledger and receipt.
That full change requires a new independent review and exact-head CI.

```sh
CLINICAL_OS_SOURCE_COMMIT=<exact Git SHA> \
npm run --silent migration:ledger-repair-sql -- \
  config/tenant.cnyos-staging.json chananya-pre-reconciliation \
  > /secure/path/cnyos-staging-pre-reconciliation-guarded-repair.sql
```

Strict post-remediation is the generator default, but it carries the same two
unconditional blockers. The explicit
`chananya-pre-reconciliation` mode above is bound only to the exact reviewed
Chananya staging origin, deployment and clinic, a full 40-character artifact
source revision, the pinned 45-entry migration manifest, and the complete
classified routine/ACL/path/trigger/default-ACL evidence bundle. It is not
enabled for repair until that bundle and the remaining hosted controls are
independently reviewed. It must not be reused for another
tenant or inferred for Jitarsa. Behind the unconditional blocker, every
write-capable mode and every read-only verifier reject anything except the exact reviewed
45-entry manifest (count and ordered version/name/SHA-256 digest). A
canonical-looking addition, replacement or reordering is not an authorized
release candidate.

Behind the current unconditional blockers, the future repair transaction is
designed to fail closed unless the staging clinic, active membership and Super
Admin created by provisioning all match; transactional
patient/Encounter/invoice/payment tables are empty; the complete schema and RLS
fingerprint is present; the pinned PostgreSQL-major/encoding, trigger-function
executable semantics, trigger bindings, ownership and ACL snapshots match; all
final database health checks pass; and the ledger has no conflicting rows. If a
later reviewed commit explicitly enables it, that transaction initializes the
canonical `supabase_migrations.schema_migrations(version, statements, name)`
shape and records every ordered migration with a source-file SHA-256 evidence
statement.

Any later enabled repair artifact is a **psql-only, direct-session** program.
Run it only after the complete-manifest review described above, in a new
session-affine `psql` process against the exact direct Chananya PostgreSQL endpoint
`db.hsmnjwxurlmsizndjlun.supabase.co:5432`, database/user `postgres`, with
certificate verification (`sslmode=verify-full` and the trusted Supabase CA):

```sh
psql -X \
  --set=ON_ERROR_STOP=1 \
  --set=AUTOCOMMIT=on \
  --file=/secure/path/cnyos-staging-pre-reconciliation-guarded-repair.sql \
  '<direct Chananya staging connection>'
```

Do not use `--single-transaction`, `ON_ERROR_ROLLBACK`, a transaction-pooling
endpoint, the Supabase SQL Editor, a driver-supplied outer transaction, or an
already-open psql transaction. The artifact refuses disabled autocommit and an
existing transaction before any ledger work; if mis-included in a caller
transaction, it deliberately rolls that transaction back and raises a hard SQL
error while its own `ON_ERROR_STOP=1` is in force, so the required direct `-f`
execution terminates nonzero. Nested `\i` execution is unsupported: PostgreSQL
17 `psql` snapshots the outer caller's error policy at the include boundary, so a caller
that reaches `\i` with `ON_ERROR_STOP=off` can mask the child error, continue a
tail command and retain a session advisory lock until disconnect. If an operator
wrapper is unavoidable, it must set `ON_ERROR_STOP=1` before `\i`; any child
error, missing exact evidence or unexpected output still invalidates the run.
No refusal or proof path relies on `\q`/`\quit` or a numeric quit argument. It rejects any
other psql `HOST`/`PORT`/`USER`/`DBNAME` tuple and, inside the transaction,
requires `pg_control_system().system_identifier` to equal the independently
reviewed Chananya cluster identity `7666007964130682852`.
Before connection, identity, XID, nonce, or advisory-lock probes, the client sets
`search_path` to `pg_catalog, pg_temp, public`; the write transaction and
post-commit proof each set the same path locally before DDL or proof expressions.
Both transactions also pin UTC, ISO/YMD dates, PostgreSQL interval formatting,
`extra_float_digits=3`, hexadecimal bytea output,
`quote_all_identifiers=off`, and `standard_conforming_strings=on` before catalog
hashes or serialized evidence are computed.

The envelope generates a new per-invocation UUID and clears prior committed
UUID/XID session state before `BEGIN`. It removes any stale temporary marker
inside the guarded write transaction, then keys the new marker by the UUID and
the repair transaction's actual top-level
`pg_current_xact_id()`. The marker is `ON COMMIT DROP`, so successful cleanup is
part of that same transaction. The repair re-reads that XID before writing evidence and
transactionally inserts the exact evidence into the locked-down persistent
`supabase_migrations.cnyos_migration_ledger_repair_receipts` registry. Its primary
key forbids UUID reuse, and its gate-token/XID uniqueness complements three exact,
validated checks: `cnyos_repair_receipt_gate_token_check` requires a 64-character
lowercase hexadecimal gate token; `cnyos_repair_receipt_xid_check` requires a
numeric repair XID; and `cnyos_repair_receipt_evidence_check` requires the entire
JSON-object/binding conjunction to evaluate `IS TRUE`, so missing or JSON-null
gate-token, run-nonce, or repair-XID keys cannot pass as SQL `NULL`. Existing
same-named checks are accepted only when their deparsed
PostgreSQL 17 definitions match exactly; permissive substitutes such as
`CHECK (true)` or the older nullable binding predicate fail before ledger mutation.
Both durable relations are access-exclusively locked before mutation and must be
persistent, ordinary, non-partitioned, `postgres`-owned tables with exact columns,
constraints and constraint-backed indexes, no RLS/policies, no inheritance, and
no triggers or rewrite rules. The receipt's only default must deparse exactly as
`clock_timestamp()` on `committed_at`. The table is owned
by `postgres`, has no non-owner ACL, and carries an exact identifying comment. Canonical SHA-256
comments on the 45 ledger rows are migration provenance only; they are not replay
receipts. Before evidence is finalized, all deferred constraints are forced
immediate and the exact 45-row invariant is rechecked after receipt insertion.
After a literal successful `COMMIT` has removed that marker, the envelope opens a
new repeatable-read, read-only proof transaction with no intervening DDL. That
proof takes `SHARE` locks before its first read and revalidates the committed receipt,
its JSON/session UUID and XID bindings, plus the exact durable ledger; only then
does the client roll back the proof transaction, release the session advisory
gate, and emit JSON. No DDL runs between the proof and evidence output. An ordinary abort,
savepoint recovery, deferred commit failure, stale marker, replayed UUID,
mismatched XID, malformed receipt, or committed-ledger drift cannot produce
success JSON.

Evidence labels config values as `expected_*`. Both the read-only verifier and
repair envelope keep observations separate: `observed_system_identifier`, server
address/port, current database, session/current user and TLS state; the repair envelope additionally
records psql connection parameters. The cluster system identifier is the
server-enforced project binding. Psql `HOST` and related fields describe the
client's connection choice and are useful corroboration, but a hostile wrapper can
rewrite psql variables; therefore run the checksum-verified artifact directly with
`-X --file`, preserve the complete command/transcript, and do not treat client
metadata alone as endpoint attestation. Server address and TLS cipher are recorded
but deliberately not hard-pinned because they may change operationally.

Exact-head CI must run `node tests/migration-ledger-psql-e2e.mjs` with real
`psql` and an ephemeral PostgreSQL 17 server. The supplied pre-reconciliation
artifact is regenerated byte-for-byte and directly exercised for wrong-cluster
and wrong-client-connection refusal. CI statically asserts both independent
review-and-authorization blockers; a copy differing only at the five reviewed
system-identifier occurrences reaches the guard blocker at runtime and proves a
nonzero exit, absence of ledger/receipt mutation and advisory-lock release. A
second native copy changes only client error controls and a terminal test-only
abort so savepoint continuation reaches both retained blockers and still cannot
write. The generic fixture cannot truthfully reproduce the classified hosted
147/141/173/7 pre-reconciliation baseline, so successful native verifier
lifecycle tests use the strict-post-remediation verifier; the pre-reconciliation
success path remains reserved for the exact hosted baseline. The PGlite contract
independently exercises both blockers. Every
executable success/atomic-failure fixture uses a separately generated strict
artifact explicitly bound to the ephemeral cluster with exactly the two source
blockers removed; no generated or retained artifact has that bypass. The native
savepoint adversary injects a controlled mid-repair exception, and a separate
deferred foreign-key fixture fails at the real `COMMIT`. Together these cover
direct `-f`, include/wrapper, disabled autocommit,
`--single-transaction`/outer transaction, two-blocker recovery, savepoint
continuation, deferred commit failure, stale UUID/XID and
durable same-nonce replay, locked receipt metadata, and absence of success JSON on
every failure. It does **not** claim byte-identical
production execution against live staging. The protected local schema-only clone
rehearses the complete ACL candidate's rollback paths, but it is not a substitute
for the exact hosted ledger verifier or for CI's repair-envelope harness.

The former transitional reconciliation status is retired. The current internal
pre-reconciliation label is
`CNYOS_CHANANYA_CLASSIFIED_COMPLETE_LEDGER_REPAIR_NOT_AUTHORIZED`; it must not be
accepted as success, and both source blockers make it unreachable. No current
artifact authorizes or completes pre-reconciliation ledger mutation.

The two manual ACL candidates are review artifacts implemented as
fresh-session-only psql programs, not migration-runner inputs. They force
`ON_ERROR_STOP`, refuse `AUTOCOMMIT=off`, and use adjacent XID probes to roll
back and reject an existing caller transaction before acquiring their advisory
lock. They also refuse a same-session pre-held key. Their exception handlers
unlock before rethrow, and their terminal release accepts neither a failed unlock
nor a residual same-session hold. PostgreSQL 17 CI exercises each exact source
file plus seeded caller writes under an explicit outer transaction,
`--single-transaction`, same-session pre-held-lock refusal, and a continued
source-blocker error path, and requires no durable/ACL change or leaked lock. The
later ordered-migration PR must provide a
separately reviewed migration-native transaction envelope; it must not copy the
psql wrapper verbatim.

Current Chananya reconciliation order: independent review of the three PR #36
security areas → exact-head CI → exact-head read-only ACL observation →
independent classification/check-in/re-review and new exact-head CI → establish
or separately complete the bootstrap and 11-role prerequisites → run the new
complete-manifest closed-world verifier → only from a later complete-manifest
reviewed commit, guarded ledger recovery → authenticated E2E. The current repair
must not run at all; any later enabled repair must not run before provisioning
because its membership and Super Admin guards reject that sequence. Reconcile
and review Jitarsa independently after Chananya, then use a separate
ordered-migration PR for approved ACL candidates. Do not merge PR #36 or promote
either candidate from this draft workstream.
Jaoball's earlier PR #38 approval is not PR #36 security sign-off unless Jaoball
separately validates all three required PR #36 SQL-security areas.

This recovery is staging-only. Never run it against Production, never use it to conceal a failed migration, and never backfill history after real patient or transactional data has been introduced.

## Protected deployment-controller environment

Do not attach a GitHub Environment or any staging secret to a workflow from a
candidate ref in this repository. Create the separate repository
`apisarit/cnyos-staging-deployment-control` with a protected default branch.
Copy and independently review the dormant bootstrap in
[`ops/cnyos-staging-controller/README.md`](../ops/cnyos-staging-controller/README.md),
then create its `cnyos-staging-publish` Environment with required independent
reviewers, prevent self-review, disallow administrator bypass, and restrict
deployment branches to that one protected branch. Create a distinct
noninteractive `cnyos-staging-rollback` Environment and principal. Pin every
controller action and dependency by full commit or integrity hash.

The publish Environment uses these canonical protected values only after the
unprivileged producer completes:

| Type | Name | Purpose |
|---|---|---|
| Secret | `CNYOS_CONTROLLER_AUTHORIZATION_JSON` | Short-lived exact-controller-run, exact-artifact, exact-target authorization packet |
| Secret | `CNYOS_CONTROLLER_SECURITY_SIGNATURE_BASE64` | Independent security reviewer's Ed25519 signature over the exact packet |
| Secret | `CNYOS_CONTROLLER_RISK_OWNER_SIGNATURE_BASE64` | Named managed-platform risk owner's independent Ed25519 signature over the exact packet |
| Protected file | `approver-registry.json` | Reviewed public-key trust root on the protected controller branch; never load it from the candidate repository or an adjacent artifact |
| Secret | `CNYOS_STAGING_NETLIFY_AUTH_TOKEN` | Token for a non-Owner principal with access only to site `7da5e39e-580d-44f1-8623-605313e2fb2b`; it must have no Production project access |
| Secret | `CNYOS_STAGING_SUPABASE_SERVICE_ROLE_KEY` | Server-only controller-owned synthetic UAT and evidence reads |
| Secret | `CNYOS_STAGING_TEST_PASSWORD` | Password for synthetic test identities; minimum 16 characters |
| Secret | `CNYOS_STAGING_DRAFT_ACCESS_BOUNDARY_TOKEN` | Opaque bearer accepted only by the independently reviewed, separate draft-access boundary; it must never be sent to a candidate origin or reused as the Netlify token |
| Protected file | `config/cnyos-public-staging.json` | Reviewed browser-public staging tenant config used by both unprivileged and independent hermetic builds |
| Protected file | `config/cnyos-production-denylist.json` | Reviewed browser-public Production identity used only as a denylist |
| Repository variable | `CNYOS_PRIVATE_DRAFT_ACCESS_BOUNDARY_URL` | Exact HTTPS origin pinned by the reviewed boundary policy; no path, query, credentials, port, or redirect |

The noninteractive `cnyos-staging-rollback` Environment contains only this
recovery secret:

| Type | Name | Purpose |
|---|---|---|
| Secret | `CNYOS_STAGING_NETLIFY_ROLLBACK_TOKEN` | Separate staging-only principal used only by rollback/reconciliation; its subject must differ from the publish principal |

Never copy the rollback token into the publish Environment or configure the two
tokens for the same Netlify account.

Broker endpoints and the known-good rollback evidence remain protected
controller configuration. The current bootstrap deliberately has no authorized
Netlify CLI dependency: as recorded in its README, the current 27.5.0 lock had
high-severity transitive advisories. Activation requires a clean pinned release
or an independently reviewed replacement implementation.

The Netlify principal restriction is a control-plane requirement, not an
application assertion. Retain a protected membership record showing that the
principal is a Publisher for only the cnyos staging project and is not a
Developer or Team Owner. Publisher membership alone still does not prove that a
normal Netlify token has deploy-only authority. Activation remains blocked until
the reviewed external broker and fresh provider evidence prove exact-site,
deploy-only authority. A hard-coded site ID cannot reduce the authority of an
account-wide token.

The service-role key and password must not be configured in Netlify browser
variables or committed files, and candidate scripts must never receive them.
The two browser-public configuration blobs may be exposed step-by-step to the
unprivileged producer; they must not be job-wide, described as secrets, or made
available to an unrelated command. Privileged final verification and
authenticated staging steps remain controller-owned. The staging Netlify
deployment separately needs its browser-safe tenant config and the
dedicated-staging database guards described in `WHITE_LABEL_DEPLOYMENT.md`.

The files `scripts/verify-staging-release-authorization.mjs` and
`scripts/verify-unlocked-staging-deployment.mjs` are candidate-side executable
specifications and offline contract fixtures only. A credentialed workflow must
not import or execute either file from a candidate checkout. The protected
controller must use its independently committed, reviewed and commit-pinned
implementation before any Netlify token, service-role key or test credential is
made available.

This staging controller does not make the candidate-owned Production deploy,
Production promotion, platform-preview, or isolated-restore workflows trusted.
Those credentialed workflows require the same protected-controller separation
before they can be treated as safe against a modified candidate ref. Nothing in
this staging protocol authorizes running or changing those Production paths.

At this checkpoint, the existing Production setup names the same Netlify site ID
and `https://cnyos.netlify.app` origin as the staging controller, while active
Production and preview workflows retain independent publish paths. That is a hard
activation blocker, not staging evidence. Without modifying or running those
Production workflows here, the signed deployment boundary and an independent
server-side publisher broker must first prove the target is staging-only, holds
no real patient data, the mapping conflict is resolved, the legacy publisher
inventory is complete, and every candidate-repository Production/preview path
and alternate token is denied this target. Otherwise no draft may be created.

For a dedicated staging Netlify site, set `CLINICAL_OS_STAGING_DEPLOYMENT=true`. Its primary deploy is still treated as non-production by the application guard and remains database-locked until the staging database acknowledgement and Production config denylist are supplied.

The first hostname below is a generic customer-staging example, not the CNYOS
target and not a value to substitute for the fixed controller policy:

Every manual staging build must also set `CLINICAL_OS_REQUIRE_SOURCE_COMMIT=true`, `CLINICAL_OS_SOURCE_COMMIT=<exact 40-character Git SHA>`, `CLINICAL_OS_SOURCE_TREE=<exact 40-character Git tree>`, and a deterministic `CLINICAL_OS_BUILD_TIMESTAMP` (use the selected commit's committer timestamp). The generated config is staged outside the tracked checkout, and `dist/runtime-publish-manifest.json` records every uploaded runtime file's exact size and SHA-256. A missing commit or tree fails the build.

For a database-locked staging artifact, verify the public locked boundary before adding any browser database configuration:

```bash
STAGING_SITE_URL=https://chananya-clinical-staging.netlify.app \
EXPECTED_STAGING_SOURCE_COMMIT=<exact Git SHA> \
npm run staging:smoke:locked
```

The canonical CNYOS staging hostname predates the marker rule. For CNYOS only, acknowledge that exact hostname (lowercase, with no scheme, path or wildcard):

```bash
STAGING_SITE_URL=https://cnyos.netlify.app \
STAGING_HOSTNAME_ALLOWLIST=cnyos.netlify.app \
EXPECTED_STAGING_SOURCE_COMMIT=<exact Git SHA> \
npm run staging:smoke:locked
```

The locked smoke gate checks source provenance, tenant/database lock, security
headers and all 11 public route shells. It is useful candidate evidence but does
**not** satisfy the authenticated staging gate. The repository workflow
materializes Function inputs from Git blobs into an isolated directory and
records every path, mode, size and SHA-256; ambient working-tree files and
ignored overlays are not inputs.

The protected controller accepts the exact commit SHA, independently checks out
and hermetically rebuilds it using protected public configuration, and byte-compares
that result with the candidate artifact as evidence only. It must turn the
independently reproduced output into the final unlocked artifact without running
candidate code under a deployment credential. It must
first create a draft Netlify deploy, verify the exact draft permalink and
closed-world expected metadata through a separate reviewed access boundary, and
only then promote that exact deploy ID. The boundary consumes its own bearer,
forwards no Authorization header/cookie/redirect to the candidate origin, and
must provide a fresh candidate-Function canary proving the credential was not
observed upstream. The
post-promotion controller-owned port of the candidate verifier contract must authenticate the
fixed site and receipt-bound current deploy, compare the Netlify file inventory
twice and every original uploaded byte with the controller-held artifact,
enforce the exact approved CSP, compose the scheduled-Function gate, validate
the staging tenant/Supabase identity, and reject any published-deploy change.
If any post-promotion or authenticated check fails, a separate controller-owned
rollback job restores the exact signed baseline only while the failed deploy is
still current. The same reconciliation deletes or revokes every rejected
non-current draft and releases the publisher lease. Draft creation requires a
server-side write-ahead intent so recovery still knows the exact target if the
runner dies before recording a local receipt. A per-run watchdog outside the
publish runner covers cancellation, timeout and runner loss, and the publisher
broker rejects a new mutation while an earlier run remains unreconciled.

Netlify's documented API does not provide a remote Function-bundle byte digest.
The isolated input and prebuilt bundle hashes are strong process provenance,
not cryptographic remote-byte attestation; the release evidence must say so.

The controller dispatch must be made by the named staging risk owner's own
GitHub login. The two distinct Ed25519 signatures must bind the candidate
commit/tree, controller repository/workflow commit, run ID and attempt, a
single-use nonce, static and Function artifact hashes, exact target, known-good
rollback deploy ID, issue time and short expiry. This is staging-only acceptance
of the documented hosted `supabase_admin` default-ACL residual risk. It is not
PR #36 approval, Production authorization, real-patient-data authorization, or
a substitute for independent review. Before any upload, the controller also
resolves `BACKUP_ENABLED` for the staging site's production Functions context,
requires the exact value `false`, proves the current deploy was created after
that setting, and verifies that the daily backup, recovery scheduler and
background worker all fail closed before configuration or Supabase access.

## What each workflow may prove

The manual workflow
`.github/workflows/authenticated-staging-e2e.yml` is an unprivileged candidate
producer only. It:

1. checks out the exact candidate without persisted Git credentials;
2. runs the complete offline source and embedded PostgreSQL behavioral suite;
3. builds a deterministic database-locked staging artifact from tracked public
   inputs;
4. materializes the Function source tree from Git blobs rather than the ambient
   checkout and emits a closed-world hash manifest;
5. proves tracked source was not changed, then uploads only those inputs with
   `if-no-files-found: error`.

It does not deploy, unlock database access, provision users, run authenticated
journeys, receive a GitHub Environment, or consume a Netlify/database/password
secret. Its success is not staging authorization.

Only after the separate protected controller has been bootstrapped and the
signed release packet has passed may the controller perform:

1. fixed-site baseline and `BACKUP_ENABLED=false` preflight;
2. live rollback-principal verification, draft upload, boundary-isolated
   exact-draft verification, immediate revalidation of the pinned rollback and
   draft-gate evidence, and promotion of that same deploy ID;
3. the full post-promotion static/schedule gate and GET/malformed-POST denial for
   both scheduled Functions on immutable and canonical origins;
4. provisioning of the 11 synthetic staging identities;
5. exact `current_access_context()` and `department_can()` role/tenant checks;
6. all ten workspace routes in mobile Chromium, including denied-route behavior;
7. migration health, ten synthetic clinical-to-payment journeys, audit and
   segregation checks;
8. reversible subscription OFF/ON proof using the original tenant boundary;
9. a final current-deploy check, atomic publisher-lease release receipt, and a
   cross-linked evidence manifest;
10. automatic exact-baseline rollback on failure, plus external watchdog
    recovery for a lost runner, rejected-draft cleanup and lease release.

The protected controller intentionally creates synthetic staging records. It
must run only after the independent Environment reviewer confirms the exact
controller commit, signed packet, staging project and site.

## Evidence and release decision

A successful protected controller run must produce:

- `pre-release-reconciliation.json`, `authorization.json`,
  `authorization-verification-bundle.json`,
  `rollback-attestation-deposit-receipt.json`,
  `rollback-attestation-deposit-validation.json`,
  `live-netlify-authority-boundary.json`, `function-environment.json`,
  `backup-disable-runtime-boundary.json`, `runtime-capability.json` and
  `preflight.json`, binding the fixed target, two signatures, immutable recovery
  deposit, live publisher boundary, known-good rollback baseline and exact
  source/static/Function hashes;
- `rollback-readiness.json`, `draft-gate.json`, `draft-intent.json`,
  `draft-receipt.json`,
  `draft-access-boundary.json`, `draft-verification.json`,
  `control-behavior.json`, `private-draft.json` and
  `exclusive-publisher.json`, all bound to one draft deploy and controller run;
- `promotion-attempt.json`, `promotion.json`, `post-promotion.json` and
  `scheduled-route-denial.json`, `final-current.json` and
  `publisher-release.json`, all bound to that same deploy ID;
- `uat.json`, cross-linking the 11-role provisioning, access matrix, mobile
  route matrix, ten synthetic journeys, migration health, audit segregation and
  subscription-restoration evidence, plus a screenshot for any browser failure;
- `final.json`, requiring every expected digest and receipt; or
  `rollback-chain-validation.json` (when promotion was attempted) plus
  reconciliation evidence proving conditional baseline restoration,
  rejected-draft cleanup and publisher-lease release.

Do not change `release-readiness.json` from `pending` based only on the presence of this harness. The authenticated staging gate may move to `passed` only after a reviewer checks the successful workflow URL, exact source commit, staging project ref, tenant code, role count, route matrix, ten journey results and unresolved failures at zero.

LINE callback/replay tests, encrypted Google Drive backup + isolated restore drill, managed database backup/PITR confirmation, and privacy/security/legal review remain separate hard gates.

The workflow's database proof exercises the service-role-only RPC directly and always restores a clinic that was verified ON at the start. The releasable staging Function configuration keeps `CNYOS_OWNER_CONTROL_ENABLED=false`; this controller does not authorize a persistent synthetic-UAT exception. The browser Owner route has an additional confirmed-Google-email allowlist and exact project/clinic guards. Activate and test any future ephemeral Owner capability separately using `docs/CNYOS_OWNER_CONTROL.md`, with enforced expiry and post-UAT revocation; a source-only console does not pass the Owner commercial gate.

The LINE gate must use the signed Messaging API callback described in `LINE_OA_MESSAGING_GATEWAY.md`, not only a locally supplied LINE ID token. The exact staging deploy must report `enabled=true` at `/api/line-oa-webhook`, pass LINE Developers **Verify**, receive a real event from the dedicated test account, and retain non-PHI `line_oa_webhook_evidence(...)` with the LIFF/QR/revoke/HN evidence.

For the backup gate, use only the `00-staging-environment` Drive tree documented in `DEPARTMENT_ACCESS_AND_BACKUPS.md`. The transaction/audit export is a fourth encrypted domain, and its manifest must report `environment=staging`, the exact source revision and zero failed domains. Do not share or configure the Production Drive tree in the staging Netlify site.
