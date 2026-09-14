# Chananya staging public-routine ACL observation — 2026-09-08

Status: closed-world discovery complete for 25 datasets; remediation and
deployment unlock are blocked. This record is not approval to execute any
ACL candidate, reconcile the migration ledger, expose the database to the
browser, merge PR #36, or deploy Production.

## Evidence boundary

The current restricted observer record was captured directly from Chananya
staging at source revision
`831543c2d1ed36b2d8242cc82af23c83e019e7a7` with PostgreSQL 17.6, after
[exact-head CI run 34158677933](https://github.com/apisarit/chananya-clinical-wellness-os/actions/runs/34158677933)
passed the native PostgreSQL 17 harness. It reported the reviewed staging system
identifier
`7666007964130682852`, a repeatable-read/read-only transaction, a literal
rollback, and successful release of the CNYOS advisory lock.

- Restricted record SHA-256:
  `235a2c612c78367e4c2beff0243b4bc624fd6107fbdc39b1f9c0af8ae4ace27e`
- Observer source SHA-256:
  `46a226f7ab7f0d3ee4f6062c1bc223dcdbee351d7640f86592e3614cb261a777`
- Current 25-dataset composite SHA-256:
  `9a555548d810ec5bed2dc86591651ca144941687c3fd34cf8d0828708ebb9efe`
- Observer status: `CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED`
- Observer flags: `authorization=false`, `production_eligible=false`

All 20 datasets shared with the earlier observation are byte-for-byte and
digest-for-digest unchanged. The earlier raw record remains retained under
SHA-256
`829d873fac8f4acec367752b06b3fb787e541a739bd190cc9d3839c5c4ac3dc5`;
its 20-dataset composite was
`e05cdcd0aa8a86b516eb4d16ed959c6afde79dfcb6c6349341a3d920d861a407`.

The current 37 MB raw JSON, the earlier 10.9 MB raw JSON, connection details,
credentials, and transcripts remain outside the repository and outside public
Actions artifacts. The hashes above identify the restricted evidence; they do
not convert it into authorization.

## Independent classification

The original observation contains 147 public routines. All are non-extension
application routines owned by `postgres`; 141 are `SECURITY DEFINER`, six are
invoker-security, 123 are ordinary Data API candidates, 23 return `trigger`,
and one returns `event_trigger`.

The live direct and effective `EXECUTE` counts are identical and all grants are
non-grantable and owner-issued:

| Principal | Executable public routines |
| --- | ---: |
| Owner (`postgres`) | 147 |
| `PUBLIC` | 16 |
| `anon` | 87 |
| `authenticated` | 90 |
| `service_role` | 116 |

There are no extension-member public routines, unresolved nonzero ACL role
OIDs, foreign grantors, or grant options. The `public` schema grants runtime
USAGE but not CREATE to `PUBLIC`, `anon`, `authenticated`, and `service_role`.
The connected runtime graph contains five anchors, 17 roles, and 24 membership
edges.

## Blocking findings

### P0 — unauthenticated clinical write

`public.apply_initial_encounter_intake(uuid,jsonb)` is an ordinary Data API
candidate, is `SECURITY DEFINER`, and is currently executable by `anon`. Its
body updates a caller-selected Encounter and inserts clinical observations
without establishing a caller, clinic membership, tenant match, or access to
that Encounter. The two superseded 2026-09-06 candidates did not remove this
exposure. The inert complete 2026-09-08 candidate classifies this routine as
owner-only and would revoke anonymous execution, but it has not been approved
or run.

### P0 — trigger-handler privilege reuse from a temporary relation

`public.apply_stock_movement()` and `public.handle_new_user()` are bound,
`SECURITY DEFINER`, persistent-write handlers that retain runtime `EXECUTE`.
The current database grants `TEMPORARY` to `PUBLIC`. A SQL-capable runtime
session can therefore create its own temporary relation, attach either exposed
handler, and fire it with the handler owner's privileges. This is a database
privilege-reuse primitive, not a claim that PostgREST directly exposes a
trigger-returning function as an ordinary RPC.

### P1 — unauthenticated integrity writes

`public.next_clinic_counter(uuid,text)` can insert or advance an arbitrary
clinic counter, and `public.next_encounter_number()` can advance the global
encounter sequence. Both are `SECURITY DEFINER`, executable by `anon`, and
lack a caller authorization check. They are intended owner-only helpers.

### P1 — the two superseded 2026-09-06 candidates cannot reach their asserted postcondition

The trigger candidate would remove 62 live ACL tuples. The browser candidate
would remove 25. Applying both hypothetically would still leave 53 anonymous
public routines and would produce the following effective matrix:

| Principal | Projected after both candidates | Candidate assertion |
| --- | ---: | ---: |
| `PUBLIC` | 1 | 0 |
| `anon` | 53 | 0 |
| `authenticated` | 74 | 70 |
| `service_role` | 94 | 75 |

The browser candidate would therefore raise and roll back. Complete closure
requires review of a further 77 privilege removals across 54 routines:
53 from `anon`, four from `authenticated`, 19 from `service_role`, and one from
`PUBLIC`. The inert complete 2026-09-08 candidate covers that projected matrix,
but remains blocked by its five unconditional authorization and verification
gates.

### P1 — unsafe function defaults would recreate exposure

The effective creators of future functions in `public` are `postgres`,
`supabase_admin`, and `pg_database_owner`. None has a global function-default
ACL row overriding PostgreSQL's hard-wired `PUBLIC EXECUTE` default. At the
time of the 25-dataset observation, both `postgres` and `supabase_admin` also
had public-schema default rows granting execution to runtime roles.

After that observation, the staging dashboard's managed **Automatically expose
new tables** setting was disabled. A separate direct read-only check, pinned to
the same system identifier and captured at `2026-09-07T21:12:57.689224Z`,
confirmed that `postgres` now has only
`postgres=X/postgres` in its public-schema function default. The managed
`supabase_admin` public-schema default still grants `postgres`, `anon`,
`authenticated`, and `service_role`, and all three effective creators still
inherit PostgreSQL's global `PUBLIC EXECUTE` default because no global override
row exists. This post-observation control change reduces future exposure but is
not contained in the observer digest and is not complete default-ACL closure.

The restricted post-toggle record is 2,296 bytes, mode `0600`, and has SHA-256
`1be7efa81a459ad950b1dba8602eb6e0d76c4f6f4185ba616c91fa52e3fe144a`.
It also records the exact public-schema creator set and the live role's missing
system-catalog lock privileges. It remains external to Git just like the raw
observer. The two superseded 2026-09-06 candidates changed existing routine
ACLs only. The inert complete 2026-09-08 candidate also closes the
tenant-controlled `postgres` and `pg_database_owner` function defaults, but it
cannot alter the remaining Supabase-managed `supabase_admin` default. Durable
enablement therefore still requires explicit acceptance of that residual risk
by a named risk owner.

A same-session follow-up also confirmed that hosted `supabase_admin` is a
Supabase-managed login/superuser, that tenant role `postgres` cannot `SET ROLE`
to it, and that it currently owns zero routines, relations, or types in
`public`. Supabase's
[hosted ownership documentation](https://supabase.com/docs/guides/self-hosting/remove-superuser-access)
says Studio-created user objects run as/are owned by `postgres`, while its
[role documentation](https://supabase.com/docs/guides/database/postgres/roles)
reserves `supabase_admin` for platform upgrades and automation. Consequently a tenant-authored candidate
must close the global and public-schema defaults for `postgres` (and the
database-owner alias when independently verified), pin all current application
objects to trusted ownership, and record `supabase_admin` as an explicit hosted
platform trust boundary. It must not pretend to alter a managed superuser's
defaults or call their continued presence a tenant-controlled grant.

### P1 — every privileged public routine needs search-path hardening

All 141 public `SECURITY DEFINER` routines set a function-local path, but none
places `pg_temp` explicitly at the end. Seventy-three use `public`, 65 use
`pg_catalog, public`, and three use `pg_catalog`. Because runtime roles have
database `TEMPORARY`, PostgreSQL otherwise searches their temporary schema
implicitly. ACL closure alone cannot unlock staging: each privileged body and
path must be reviewed, then normalized to a trusted path with explicit terminal
`pg_temp`, or to an empty path with every referenced object qualified.

### P2 — live-only event trigger

`public.rls_auto_enable()` is a live-only `SECURITY DEFINER` event-trigger
function granted to `PUBLIC`, `anon`, `authenticated`, and `service_role`.
It is not an ordinary PostgREST RPC because it returns `event_trigger`, but its
non-owner execute grants are unnecessary. Its event-trigger binding must be
captured and reviewed before owner-only remediation is promoted.

## Closed-world binding results

The current observer adds these five closed-world datasets to the original 20:

- `trigger_bindings.all_non_internal`
- `event_trigger_bindings.all`
- `database_role_settings.current_database_and_global`
- `schemas.all_non_temporary.security`
- `current_database.security`

The output uses artifact schema
`cnyos-public-routine-acl-observation/v2` and contains 25 datasets.

They include private-schema bindings instead of assuming that every relevant
handler lives in `public`. Each binding also commits to handler semantics and
ACLs, handler-owner role state, all memberships/settings, and a digest of every
non-temporary schema's raw/effective trust state. Current-database ownership and
ACL state is also bound because `pg_database_owner` and temporary-schema access
are database-dependent. Missing or dynamic handler `search_path` values are
explicitly flagged. Any quoted identifier is conservatively classified for
manual review so a comma or `pg_temp` substring inside a quoted schema name
cannot be mistaken for a safe terminal `pg_temp` token. Direct `pg_language`
catalog/ACL state is bound, but its implementation binary and arbitrary objects
referenced by function bodies remain separate review scope.

The live binding datasets contain 173 enabled persistent non-internal trigger
bindings: 168 use 23 public handlers, four use three expected `storage`
handlers, and one uses the expected Realtime handler. They contain seven
enabled event triggers: six expected Supabase `extensions` handlers and the
custom `ensure_rls` binding to `public.rls_auto_enable()`. No live temporary
relation, unresolved ACL identity, unexpected language, or inconsistent
repeated handler context was found. The platform-owned non-public handlers are
explicit allowlist entries; they are not assumed safe merely because of their
schema and must not be modified without compatibility testing.

## Required next gates

1. Review the checked-in compact manifest, routine/binding disposition, and
   distinct closed-world read-only verifier status as nonauthorizing artifacts
   bound to the exact observer digests.
2. Repeat exact-head CI and independent review, then run only that read-only
   verifier.
3. Independently review the inert complete current-ACL/default-ACL and
   privileged search-path candidate at SHA-256
   `2f374ca556a1f98f46ec179b2e8143d56c7f900d7d1812e2dc7f5e23439e4acf`.
   Complete both exact rollback-only rehearsal modes, temporary-trigger denial,
   positive existing-trigger regression, and the fresh post-rehearsal observer
   under the dedicated maintenance protocol. Keep all durable repair and ACL
   mutations blocked until their separate gate is satisfied.
4. Reconcile Chananya, then independently reconcile Jitarsa, promote approved
   changes in an ordered migration PR, and complete authenticated staging
   regression before any Production gate.
