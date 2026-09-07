# Authenticated staging release gate

Status: harness present; execution evidence pending. This runbook does not authorize a Production target and does not mark the commercial release gate as passed.

The protected workflow verifies the exact release candidate against a dedicated Netlify site and a dedicated Supabase project. It provisions synthetic identities, checks database authorization for every role, loads every workspace in a real mobile Chromium session, and runs ten synthetic Practitioner → Pharmacy → Billing journeys through full payment and Encounter closure.

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

The recorded aggregate baseline is incomplete: it implies 53 ordinary
anonymous-executable `SECURITY DEFINER` routines beyond the 17 named browser
drifts, plus one live-only public routine. After independent design review of
the ACL, read-only and rollback controls and exact-head CI, run the standalone
observer first from the exact PR commit:

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
independently classify every routine, raw/effective ACL, extension membership,
schema privilege, connected runtime-role edge and default function ACL. Check
the reviewed exact live manifest into a new PR #36 commit and repeat independent
review and exact-head CI before running the closed-world verifier.

Its fresh-session detector deliberately calls `pg_current_xact_id()` in two
adjacent autocommit statements. PostgreSQL therefore allocates two permanent
transaction IDs before the read-only observation snapshot; that accounting
effect is expected and does not change application rows, catalogs or ACLs. The
artifact forces UTF-8 psql output and pins every supported catalog-deparsing and
JSON-text output GUC before hashing. Exact-head CI runs the unmodified observer
with a PostgreSQL 17 `psql` client against an ephemeral PostgreSQL 17 server,
including hostile caller GUCs/client encoding, a non-ASCII routine, missing or
malformed metadata refusal, outer-transaction refusal, same- and cross-session
advisory-lock contention, and injected post-acquisition failure. It checks exact
one-line LF-terminated output, empty success stderr, an exact 0→1→0
advisory-lock lifecycle, error cleanup, and before/after no-mutation state. The
observer refuses before acquisition if its session already holds the key and
emits evidence only after both a successful unlock and proof that the session
has zero remaining holds.

CI generates the current known-subset verifier for review, but that artifact is
diagnostic only and cannot satisfy a closed-world preflight. After the observer
manifest has been checked in and the generator has been updated to require that
complete manifest with a distinct complete-manifest status, repeat independent
review and exact-head CI. Only then regenerate and execute the verification-only
artifact from that later exact reviewed PR commit:

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

The artifact generated by the current revision instead has status
`CNYOS_CHANANYA_PRE_RECONCILIATION_KNOWN_ACL_SUBSET_MATCHED_NOT_AUTHORIZED`.
It sets `authorization=false`, `live_callable_acl_inventory_complete=false`,
`ledger_reconciliation_authorized=false`, and
`ledger_reconciliation_blocked_pending_live_callable_acl_inventory=true`;
therefore even a zero-exit result is diagnostic evidence, not repair
authorization and cannot enable repair. The current Chananya strict diagnostic
similarly uses
`CNYOS_STAGING_STRICT_POST_REMEDIATION_SCHEMA_GUARD_MATCHED_NOT_AUTHORIZED`.
Every current verifier mode carries those non-authorization/incomplete-inventory
flags, `ledger_reconciled=false`, and `production_eligible=false`. A later,
differently statused complete
preflight can be accepted only when the exact artifact checksum/source commit and
independently confirmed Chananya target match, the transcript contains one
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
non-executable**. Each generated repair
raises `CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED` in both the
guard and the sole mutation block before any temp-table DDL, application
healthcheck, ledger/receipt mutation or success evidence. Do not run it. Only a
later independently reviewed commit with the complete all-routine semantic/ACL,
extension and function-creator default-ACL manifest may remove those blockers
and enable execution. Regenerate that later exact-head artifact
before use:

Removing the two exceptions by itself is not an enabling change. The later
commit must bind the reviewed all-routine/default-ACL digests into its gate token
and evidence, change the current non-authorization/incomplete-inventory fields,
and prevent catalog/role/default-ACL drift across verification and ledger commit
with reviewed locks or an equivalent commit-time revalidation. The post-commit
proof must recheck those authorization prerequisites, not only the ledger and
receipt. That full change requires a new independent review and exact-head CI.

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
source revision, the pinned 45-entry migration manifest, and the currently known
browser-RPC subset and trigger-function snapshot. It is not enabled for repair
until the complete live routine/ACL/default-ACL manifest is independently
reviewed. It must not be reused for another
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
live-inventory blockers; a copy differing only at the five reviewed
system-identifier occurrences reaches the guard blocker at runtime and proves a
nonzero exit, absence of ledger/receipt mutation and advisory-lock release. A
second native copy changes only client error controls and a terminal test-only
abort so savepoint continuation reaches both retained blockers and still cannot
write. The PGlite contract independently exercises both blockers. Every
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
production execution against live staging. This local Codex host has no
`psql`, PostgreSQL server, Docker or Podman, so the real-client harness is CI-only;
the local PGlite contract remains the strongest available transactional check.

The transitional status is reserved for a future explicitly enabled repair:
`CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING`
may be accepted only with `ledger_reconciled=true`, both remediation-pending flags true,
`production_eligible=false`, matching trigger semantic/binding digests, no SQL
errors and zero client exit. The current blocked artifact cannot emit it. It is
not `READY`.

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

## Protected GitHub environment

Create a GitHub environment named `staging` and require a reviewer. Configure:

| Type | Name | Purpose |
|---|---|---|
| Secret | `CLINICAL_OS_STAGING_CONFIG_JSON` | Complete browser-safe staging tenant config |
| Secret | `CLINICAL_OS_PRODUCTION_CONFIG_JSON` | Customer's browser-safe Production config, used only as a denylist |
| Secret | `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Server-only provisioning and evidence reads |
| Secret | `STAGING_TEST_PASSWORD` | Shared password for synthetic test identities; minimum 16 characters |
| Variable | `STAGING_SITE_URL` | Exact HTTPS origin of the isolated staging site |
| Variable | `STAGING_TEST_EMAIL_DOMAIN` | Domain used only for synthetic Auth users |

The service-role key and password must not be configured in Netlify browser variables or committed files. The staging Netlify deployment separately needs its browser-safe tenant config and the preview database guards described in `WHITE_LABEL_DEPLOYMENT.md`.

For a dedicated staging Netlify site, set `CLINICAL_OS_STAGING_DEPLOYMENT=true`. Its primary deploy is still treated as non-production by the application guard and remains database-locked until the staging database acknowledgement and Production config denylist are supplied.

Every manual staging build must also set `CLINICAL_OS_REQUIRE_SOURCE_COMMIT=true` and `CLINICAL_OS_SOURCE_COMMIT=<exact Git SHA>`. The build publishes a credential-free `deploy-manifest.json`; a missing or malformed required revision fails the build. After deployment, verify the public locked boundary before adding any database credential:

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

The locked smoke gate checks source provenance, tenant/database lock, security headers and all 11 public route shells. It is useful deployment evidence but does **not** satisfy the authenticated staging gate.

## What the workflow proves

The manual workflow `.github/workflows/authenticated-staging-e2e.yml` performs:

1. the complete source and embedded Postgres behavioral suite;
2. provisioning of 11 synthetic identities: Practitioner, Doctor, Reception, Pharmacy, Production, Inventory, Quality, Billing, Admin, Super Admin and Viewer;
3. exact `current_access_context()` tenant/role verification for each identity;
4. the complete `department_can()` allow/deny matrix, including the rule that only Super Admin receives cross-workspace access;
5. all 10 workspace routes in mobile Chromium for every role, including denied-route behavior and visible navigation;
6. migration health checks for hybrid identity, clinical/financial handoffs, prescription dispensing, production and independent Quality;
7. ten synthetic patient journeys through registration, manual-HN identity fallback, Encounter, Thai medicine diagnosis, prescription, Pharmacy review, FEFO lot allocation, Billing, payment and Encounter closure;
8. negative segregation checks and required audit actions;
9. reversible subscription OFF/ON proof: an already-issued Practitioner session loses `current_clinic_id()` and Clinical capability while OFF, then regains only its original tenant/department boundary after ON;
10. JSON evidence and failure screenshots retained against the exact Git commit for 90 days.

The workflow intentionally creates synthetic staging records. Run it only after the protected environment reviewer confirms the target project and site.

## Evidence and release decision

A successful run produces:

- `staging-user-provisioning.json`;
- `authenticated-staging-matrix.json`;
- `authenticated-staging-synthetic-uat.json`;
- a screenshot for any browser failure.

Do not change `release-readiness.json` from `pending` based only on the presence of this harness. The authenticated staging gate may move to `passed` only after a reviewer checks the successful workflow URL, exact source commit, staging project ref, tenant code, role count, route matrix, ten journey results and unresolved failures at zero.

LINE callback/replay tests, encrypted Google Drive backup + isolated restore drill, managed database backup/PITR confirmation, and privacy/security/legal review remain separate hard gates.

The workflow's database proof exercises the service-role-only RPC directly and always restores a clinic that was verified ON at the start. The browser Owner route has an additional confirmed-Google-email allowlist and exact project/clinic guards. Activate and test that boundary separately using `docs/CNYOS_OWNER_CONTROL.md`; a source-only console does not pass the Owner commercial gate.

The LINE gate must use the signed Messaging API callback described in `LINE_OA_MESSAGING_GATEWAY.md`, not only a locally supplied LINE ID token. The exact staging deploy must report `enabled=true` at `/api/line-oa-webhook`, pass LINE Developers **Verify**, receive a real event from the dedicated test account, and retain non-PHI `line_oa_webhook_evidence(...)` with the LIFF/QR/revoke/HN evidence.

For the backup gate, use only the `00-staging-environment` Drive tree documented in `DEPARTMENT_ACCESS_AND_BACKUPS.md`. The transaction/audit export is a fourth encrypted domain, and its manifest must report `environment=staging`, the exact source revision and zero failed domains. Do not share or configure the Production Drive tree in the staging Netlify site.
