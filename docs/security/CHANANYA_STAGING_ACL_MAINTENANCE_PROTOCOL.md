# Chananya staging ACL maintenance protocol

Status: **not authorized for durable mutation or deployment**. This protocol
defines the remaining staging gates; it is not an approval, a security sign-off,
or a production release record.

PR #36 must remain draft and unapproved. It must not be merged because `main`
publishes to Netlify. Every command below is restricted to Chananya staging
project `hsmnjwxurlmsizndjlun`, database system identifier
`7666007964130682852`, and the dedicated cnyos Netlify site
`7da5e39e-580d-44f1-8623-605313e2fb2b`. Production is out of scope.

## 1. Exact-source gate

Before any hosted rehearsal, record and independently review all of the
following from one clean checkout:

- the 40-character Git revision and tree;
- the candidate SHA-256
  `2f374ca556a1f98f46ec179b2e8143d56c7f900d7d1812e2dc7f5e23439e4acf`;
- the rollback-rehearsal generator, runner, tests, and their blob IDs;
- exact-head CI with PostgreSQL 17 native tests;
- reviewer identity, date, scope, findings, and verdict.

An author-account AI comment, a prior approval for PR #38, or a passing test is
not PR #36 security sign-off. The source candidate must retain all five
unconditional blockers. Only the exact-SHA rollback-only derivative may bypass
them, and that derivative must contain no executable `COMMIT`.

## 2. Managed-platform exception gate

Tenant role `postgres` cannot change the Supabase-managed `supabase_admin`
default privileges. Durable enablement therefore requires a named risk owner to
accept this narrowly scoped hosted-platform exception. The acceptance record
must contain:

- owner name and role;
- exact project ref and system identifier;
- scope: `supabase_admin` function defaults for `public` only;
- evidence that `supabase_admin` owns zero current `public` routines, relations,
  and types;
- evidence that runtime/untrusted login roles cannot `SET ROLE` to any reviewed
  creator;
- rationale, acceptance date, expiry date, and next review date;
- the recurring/pre-deploy drift check owner;
- a Supabase support case or documented provider escalation;
- an explicit decision to block on any ownership, creator, role-attribute,
  membership, or default-ACL drift.

Absent that record, rollback-only rehearsal may proceed after technical review,
but no durable ACL change, migration-ledger repair, staging release, or
deployment may be described as authorized.

## 3. Maintenance and quiescence gate

Immediately before each hosted rehearsal or later authorized mutation:

1. Re-read the Netlify cnyos site by its exact site ID. Require
   `BACKUP_ENABLED=false` in function scope and an active deploy created after
   that setting. The daily backup, recovery scheduler, and background worker
   must all fail closed before configuration or Supabase access.
2. Announce a staging-only maintenance window and stop synthetic journeys,
   operator writes, imports, backups, and manual “Run now” actions. Do not
   terminate Supabase-managed sessions.
3. From a separate read-only direct session, reject active or
   idle-in-transaction tenant/application writers. Record counts and only
   privacy-safe metadata. A platform background process is not itself a reason
   to terminate a session.
4. Capture a fresh v2 observer from the exact source revision. Require the exact
   project/database/user/TLS/system identity, 25 datasets, 147 public routines,
   141 `SECURITY DEFINER` routines, 173 enabled persistent non-internal
   triggers, seven event triggers, literal rollback, and advisory unlock.
5. Compare the fresh observation with the reviewed manifest. Any count, digest,
   owner, ACL, path, binding, schema, role, database setting, or creator drift
   blocks the run.

The candidate acquires one C-sorted `SHARE ... NOWAIT` lock over exactly 91
reviewed ordinary relations before its repeatable-read snapshot. A conflicting
writer must cause a deterministic abort, never a wait-and-continue decision.
The transaction must prove that its granted `ShareLock` OID set is exactly that
91-relation set, then recheck the single active Chananya clinic identity while
`public.clinics` remains locked.

## 4. Rollback-only hosted rehearsal

Run both modes in new direct PostgreSQL 17 sessions:

1. normal mutation path ending in explicit `ROLLBACK`;
2. injected failure after the candidate mutation region.

The runner must pin the psql client, trusted CA, exact service-file keys, direct
hostname/address/port, TLS verification, database/user, application name,
system identifier, candidate SHA, and clean source revision. It must revalidate
protected-file identity before and after every subprocess. Every session outside
the one explicit candidate transaction starts with
`default_transaction_read_only=on`.

For each mode retain, outside the repository with mode `0600`, the generated
SQL, read-only pre/post snapshots, stdout/stderr, exit status, client and input
hashes, timestamps, and receipt. Snapshot equality proves only the catalog and
ACL surface actually included in the snapshot; label it
`ACL_CATALOG_ROLLBACK_VERIFIED`, not whole-database or external-side-effect
atomicity. A fresh full v2 observer remains mandatory after both modes.

## 5. Ambiguous-result recovery

If the rollback rehearsal disconnects or its result is ambiguous, do not infer
success and do not rerun immediately. A fresh connection must first prove:

- no CNYOS advisory lock remains;
- the transaction is gone;
- the pre/post ACL-catalog snapshot is equal;
- the full v2 observer and migration-ledger verifier still match the reviewed
  baseline.

An explicit rollback receipt is required for the normal mode. The injected
failure mode must exit nonzero with the exact injected error and equal post-state.
Any mismatch freezes the staging release for investigation.

For a later durable migration, loss of the client after `COMMIT` is a different
case: never retry until a fresh observer, ledger verifier, and durable receipt
prove whether the commit occurred. A connection error is not evidence of
rollback.

## 6. Promotion and deployment order

After independent review, both rollback rehearsals, the fresh post-observer,
and the managed-platform acceptance:

1. reconcile Chananya's ledger with its own reviewed authorization and receipt;
2. independently repeat the ledger decision for Jitarsa—never reuse Chananya's
   authorization;
3. create a separate PR that promotes approved SQL into the ordered migration
   chain; do not copy the psql wrapper into a migration;
4. apply that chain to Chananya staging and run authenticated regression;
5. bootstrap a separate protected deployment-control repository. Do not put its
   privileged workflow on this repository's candidate branch or merge it to
   `main`, because either route crosses an untrusted or Production boundary.
   Its default branch and `cnyos-staging-publish` Environment require
   independent review and no self-review/admin bypass; its distinct
   `cnyos-staging-rollback` Environment must be noninteractive and use a
   separately scoped principal. Follow the fail-closed bootstrap in
   `ops/cnyos-staging-controller/README.md`. The publish and rollback principals
   must each have project access only to cnyos site
   `7da5e39e-580d-44f1-8623-605313e2fb2b` and no Production project access;
   a normal Netlify personal access token and signed role booleans do not prove
   that boundary. Activation additionally requires a fresh external authority
   attestation covering provider role/capabilities, owner/admin absence, the
   complete site inventory, and every Git/UI/hook/token/workflow publisher;
6. bind two independent signatures to the exact controller run/commit, nonce,
   candidate commit/tree, static and Function artifact hashes, exact target,
   known-good rollback deploy and short expiry. Upload a draft, verify it, then
   promote only that exact deploy ID. Verify deploy metadata, the closed
   Function/schedule set, route denial, target identity, and staging journeys;
7. automatically restore the signed baseline if any post-promotion gate fails,
   but only while the failed deploy remains current. Retain an external
   watchdog for cancellation, timeout or runner loss;
8. keep the production gate closed until a separately authorized production
   release.

No step in this document authorizes merging PR #36 or touching production.
