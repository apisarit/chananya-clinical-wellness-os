# Native membership recovery checkpoint — 2026-09-12

Outcome: **8 bounded functional checks passed on PostgreSQL 17.11** at
`2026-09-12T15:39:13.953Z`. The fixture server was stopped and a follow-up
`pg_ctl status` reported no server running. This is not authenticated hosted
staging, durable controller recovery, SQL activation or a release approval.

The previous goal turn made source progress by adding receipt-bound UAT closure
and the version index. This turn adds actual native multi-session observations;
it does not count repeated remote-status checks as deployment progress.

## What was executed

The harness creates its own new cluster and private Unix socket, disables TCP,
sets directory permissions to `0700`, ignores ambient database configuration,
and passes explicit local connection parameters to `psql -X`. Its database
objects belong to a non-superuser, non-BYPASSRLS fixture owner. Workflow sessions
assert `current_user=authenticated` before their RPCs. Actor identity and the
capability helper are deliberately synthetic fixture implementations.

| area | verdict | evidence | limit |
| --- | --- | --- | --- |
| Direct candidate refusal | PASS | Original candidate aborts before fixture installation; receipt table absent | Original blocker remains intact; the harness installs only marked definitions into its own disposable database |
| Normal OFF/ON and historical replay | PASS | Full original boundary restored except for the new version; historical receipts equal on replay; two audits/receipts | Minimal fixture, not actual hosted session behavior |
| Same-request concurrency | PASS | Second backend observed waiting on first; equal receipts and exactly one audit/receipt | One synthetic actor/target pair |
| Competing request IDs | PASS | Observed blocking; first request commits; second rejects the stale expected state without adding an audit/receipt | Does not prove every isolation level or writer combination |
| Legacy write preservation | PASS | Concurrent ordinary membership update retained; stale restore rejected | Direct ordinary SQL writer, not the complete legacy RPC/trigger graph |
| Lock timeout | PASS | Observed blocking, native timeout and unchanged fresh state/receipt/audit snapshot | Particular profile-lock path only |
| Disconnect before commit | PASS | Backend exit observed; provisional state, audit and receipt all rolled back | Proves database behavior, not a durable runner journal |
| Disconnect after committed ON | PASS | Commit independently visible, backend exited, exact retry equals stored full historical receipt and leaves snapshot unchanged | Simulated loss at the local client boundary, not the hosted HTTP gateway |

Barriers poll `pg_blocking_pids` or independently visible database state. Fixed
elapsed waits alone are not used as evidence of concurrency or commitment.

## Reproduce only in a new local fixture

```sh
npm run check:membership-native -- --pg-bin /absolute/path/to/postgresql17/bin
```

The command accepts a PostgreSQL binary directory, **not** a database URL,
existing data directory or connection string. It creates and targets only its
own fixture cluster. Existing native PostgreSQL 17 binaries are required; it
does not download software or connect to a managed project. Test source and
fixture data contain no real patient data or credentials.

The harness prints progress on stderr and one JSON result on stdout only after
successful tests and verified shutdown. This run's receipt was extracted from
the execution tool's combined stream display; it is not described as an
independently retained raw stdout/stderr pair. The source-generated native
cluster and log were retained under the private directory
`/tmp/cnyos-native-DjaiH0` for diagnosis, not deleted or reused as a baseline.
Temporary storage may be removed by the OS; durable result evidence is retained
separately in the restricted workspace evidence area.

## Exact tested sources and limits

The run used a dirty checkout based on
`9de6cd2d5fba9e3da518071ac59289041cbf634b`. That commit does not contain the
uncommitted changes. The receipt binds these exact source bytes:

| Source | SHA-256 |
| --- | --- |
| `tests/staff-membership-native-recovery.mjs` | `2d32416b6fc313bdfaf019a5e6fc0171fe6abf590da211a74bb295bc034ae726` |
| `tests/fixtures/staff-membership-native-fixture.sql` | `d0446da001bc5a2892c2e94f28ccc0f3c279351026c99a18f892c1228b2f354b` |
| `supabase/manual/staff_membership_recovery_candidate.sql` | `7eafb1718b7f47839eccd18d4d434bcd109285d0be2eb94e149f0d3ebc07cc33` |

Separate Astra source review identified cleanup-signal handling and incomplete
historical-receipt comparison; both were corrected before this run. The
reviewer confirmed bounded execution readiness but did not itself execute the
native harness or supply independent human approval. Root performed the native
run after repeated Luna worker-slot failures. Shutdown on the normal success
path was observed; every possible cancellation or host-failure path was not.

The receipt explicitly reports `hostedStagingVerified=false`,
`durableRunnerRecoveryVerified=false`, `independentHumanApproval=false` and
`productionAuthorized=false`. No migration, PR merge, hosted SQL or Netlify
deployment occurred. The manual candidate and all release gates remain blocked.

Current read-only GitHub checks still show PR #36 draft/unmerged at `dc6c8c7`,
two current-head Jaoball approvals with empty scope descriptions, and controller
`main` at `ce6f6a66e014a609eb899a3b62d5f0741c6e83e2` with protection disabled.
These observations do not establish the required independent scoped assessment.

Next implementation requirement: a protected write-ahead request/expected-state
journal and recovery worker that can retrieve the same receipt after process
loss, preserve conflicts, and record a durable non-reusable terminal outcome.
The complete hosted auth/RLS/default-ACL graph, independently reviewed SQL
promotion, live staging and deployment gates remain separate requirements.

References: PostgreSQL 17 [row locking](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)
and [activity monitoring](https://www.postgresql.org/docs/17/monitoring-stats.html).
