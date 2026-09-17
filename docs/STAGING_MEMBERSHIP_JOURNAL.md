# Membership UAT: persistent recovery candidate

Component `1.0.0-candidate.2`, local source changes based on `9928871`.
This is a working, locally tested helper/storage composition, **not an installed
protected controller, live staging evidence, a clinical-case closure, or release
authorization**. No workflow, SQL candidate guard, ordered migration, database
credential, approval flag, or hosted service is changed by this component.

## What is implemented

The credential-free membership helper accepts an awaited `checkpoint(snapshot)`.
It persists original OFF/ON request IDs, exact initial state, target/actor, and
validated receipts in this order:

`off-intent → off-confirmed → on-intent → on-confirmed → completed`

Both mutation intents must be committed before the corresponding RPC can run.
An unsuccessful checkpoint stops before the next mutation. Lost replies retain
the original intent for recovery; retries never allocate new IDs or rebase to a
later membership version. Completion additionally reads the exact current state
and requires equality with the restored receipt, then returns the existing
request-ID-bound `closureConfirmation`. A historical ON receipt and healthy
role context alone no longer establish current restoration.

`recoverStaffMembershipProof` validates the retained checkpoint before I/O. It
reuses only the original operation IDs/expected states, verifies the restored
context and current state, and can itself be interrupted and resumed. If the
OFF intent exists but its receipt was lost, replay may complete that same
original operation before its exact restore. Once ON intent exists, recovery
never sends OFF again. Changed state/actor/target/source must not be overridden.

Recovery returns `disposition: recovered`, `freshUatEvidence: false`, and
`requestId` equal to the original ON ID. It does **not** produce a verified UAT
closure, rerun denial as if it were the original test, or convert an unknown or
failed denial result into success. A completed run refuses start/recovery. A new
test needs a distinct run and new operation IDs; status inspection is explicitly
historical and does not refresh evidence timestamps.

## Controller storage boundary

`ops/cnyos-staging-controller/scripts/membership-journal-store.mjs` contains no
network/RPC clients, environment/credential reads, candidate imports, or
background worker. It exports:

- `initializeMembershipJournal(directory)`: explicit first-time initialization
  in an existing canonical, current-user-owned `0700` directory. Existing or
  partial stores are refused, never overwritten or automatically recreated.
- `withMembershipJournal({directory, binding, mode}, action)`: `start` or
  `recover`, holding a process lock while the protected caller runs the action.
  The action receives `{snapshot, checkpoint}` for the pure helper.
- `abandonUnstartedMembershipRun({directory, binding})`: closes only a run with
  **no persisted OFF intent**, without invoking callbacks or RPCs. Its original
  IDs/history remain reserved. This handles initial-read failure or process loss
  before any mutation was permitted; a run with an intent requires recovery.
- `readMembershipJournal({directory, binding})`: read-only historical status.

Bindings contain a local membership-run UUID, controller and candidate commit
SHAs, artifact SHA-256, fixed `cnyos-staging` label, actor, target boundary, and
the two request IDs. They are compared exactly on recovery. These supplied
fields are **not** proof of their own provenance or authorization. The future
protected bridge must derive/verify them from its independently approved source,
artifact, target and authorization inputs; a caller-supplied hash is not approval.

Two separate SQLite files serve different purposes. A write transaction in the
lock file remains open across the action, while each snapshot commits separately
to the journal file with `synchronous=EXTRA` and `fullfsync=ON`. This prevents a
process exit from rolling back the already-written intent along with the lock.
OS process death releases the lock; no timer/PID-based stealing or expired-lease
shortcut is implemented. Any earlier unresolved run blocks new runs in the
same store, even for a different target. IDs cannot be reused across runs.

Requires Node.js 24 on a **single trusted host with local persistent storage**.
The current application Node >=20 requirement is unchanged; the separate
journal test requires Node 24. Only existing built-in SQLite is used, not a new
downloaded dependency. See the [Node SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
and [SQLite durability settings](https://www.sqlite.org/pragma.html#pragma_synchronous).

The local-disk/process-lock design is not a distributed broker. Do not put it on
NAS/Drive/NFS or an ephemeral CI workspace and claim external durable recovery.
No backup retention service, machine/power-loss rehearsal, host compromise
protection, distributed failover, or tamper-proof signature is supplied. A
trusted OS owner can alter the files; private permissions and SHA-shaped inputs
are not cryptographic authorization. Keep the entire store outside candidate
workspaces, published trees, ordinary build artifacts and untrusted shared paths.
The stored actor/target/state records are operational data even when synthetic.

## Integration and verification

The existing `verify-authenticated-staging.mjs` remains a candidate script and
does not receive this filesystem adapter or controller secrets. Its helper's
checkpoint option stays optional for existing unprivileged fixture callers.
The dormant protected UAT entrypoint is still absent in this checkout; sibling
controller preparation packages still refuse activation. This change must not
be described as having connected or unlocked that entrypoint.

The IPC-only functional fixture composes the real helper and real disk store:
its parent owns a synthetic idempotent RPC model, so state survives child death.
It uses acknowledged checkpoint/commit barriers, actual `SIGKILL`, observed child
exit, and fresh processes. No HTTP, Supabase, Netlify, real identity, SQL
migration, or clinical data is involved.

```sh
node tests/staging-membership-checkpoint-contract.mjs
npm run check:membership-journal
npm run check:version-index
node tests/staging-safety-contract.mjs
```

The journal suite includes interruption before OFF, after OFF commit with lost
reply, before ON, after ON commit with lost reply, after ON receipt, during
recovery, and after terminal persistence. It also checks concurrent lock refusal,
unresolved-run exclusion, exact binding, ordinary concurrent state changes,
completed-run non-replay, private initialization, original-ID reservation, and
no-effect abandonment. The earlier native PostgreSQL results in
[the native checkpoint](STAGING_MEMBERSHIP_NATIVE_RECOVERY.md) are historical
SQL-candidate evidence, not a new hosted or exact-commit run for this follow-up.

Outstanding: independently installed/reviewed protected UAT bridge, real signed
authorization/broker/recovery baseline, service adapters, watchdog operation,
live authenticated staging and required independent approval. Account recovery
alone does not complete the full clinical workflow or authorize deployment.

## Review checkpoint — 2026-09-12

Separate read-only Astra technical review: **PASS for the local composition**
on an uncommitted working tree based on
`992887171537259088e2ef991711929bbd76ff96`. The reviewer executed the checkpoint
contract and all 12 journal/process tests successfully. Its finding that a
pre-intent failure could permanently block a run was fixed with the explicit
no-effect abandonment path and regression tests; denial-result validation was
also aligned. The reviewer reported no outstanding confirmed findings in the
five implementation/test files. A later stdout-only edit removed an obsolete
case-count label; it changed no assertions or execution behavior.

This is not CI on a newly committed SHA, review of all CNYOS SQL/security, an
independent human sign-off, hosted staging evidence, or permission to activate.
Luna implemented the helper/checkpoint contract; root integrated the persistent
adapter, IPC process tests, documentation and version index. No Ollama or
Jaoball approval is claimed.
