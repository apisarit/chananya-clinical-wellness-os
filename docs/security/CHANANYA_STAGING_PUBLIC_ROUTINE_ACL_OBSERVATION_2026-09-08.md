# Chananya staging public-routine ACL observation — 2026-09-08

Status: discovery complete for the original 20 datasets; remediation and
deployment unlock are blocked. This record is not approval to execute either
ACL candidate, reconcile the migration ledger, expose the database to the
browser, merge PR #36, or deploy Production.

## Evidence boundary

The restricted observer record was captured directly from Chananya staging at
source revision `21c12683e8be06d7b42f3491274d6bb5104d6825` with PostgreSQL
17.6. It reported the reviewed staging system identifier
`7666007964130682852`, a repeatable-read/read-only transaction, a literal
rollback, and successful release of the CNYOS advisory lock.

- Restricted record SHA-256:
  `829d873fac8f4acec367752b06b3fb787e541a739bd190cc9d3839c5c4ac3dc5`
- Observer source SHA-256:
  `e74d89feac2c2bf3d6b5a2361e894dbdf04275d173facc4fccc481a7e6c1092e`
- Original 20-dataset composite SHA-256:
  `e05cdcd0aa8a86b516eb4d16ed959c6afde79dfcb6c6349341a3d920d861a407`
- Observer status: `CNYOS_PUBLIC_ROUTINE_INVENTORY_OBSERVED`
- Observer flags: `authorization=false`, `production_eligible=false`

The 10.9 MB raw JSON, connection details, credentials, and transcripts remain
outside the repository and outside public Actions artifacts. The hashes above
identify the restricted evidence; they do not convert it into authorization.

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
that Encounter. Neither current ACL candidate removes this exposure.

### P1 — the two candidates cannot reach their asserted postcondition

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
`PUBLIC`.

### P1 — unsafe function defaults would recreate exposure

The effective creators of future functions in `public` are `postgres`,
`supabase_admin`, and `pg_database_owner`. None has a global function-default
ACL row overriding PostgreSQL's hard-wired `PUBLIC EXECUTE` default. The first
two also have public-schema default rows that grant execution to runtime roles.
Current candidates change existing routine ACLs only and do not remediate these
defaults.

### P2 — live-only event trigger

`public.rls_auto_enable()` is a live-only `SECURITY DEFINER` event-trigger
function granted to `PUBLIC`, `anon`, `authenticated`, and `service_role`.
It is not an ordinary PostgREST RPC because it returns `event_trigger`, but its
non-owner execute grants are unnecessary. Its event-trigger binding must be
captured and reviewed before owner-only remediation is promoted.

## Why a fresh observation is required

The original observer cryptographically covers 20 datasets but does not include
`pg_trigger` or `pg_event_trigger` bindings, database-role settings, the
all-schema trust context, or current-database ACL/ownership. The source now
adds five closed-world datasets:

- `trigger_bindings.all_non_internal`
- `event_trigger_bindings.all`
- `database_role_settings.current_database_and_global`
- `schemas.all_non_temporary.security`
- `current_database.security`

The revised output uses artifact schema
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
referenced by function bodies remain separate review scope. The exact revised
observer must pass native
PostgreSQL 17 CI and independent review before it is run against staging. Its
new output must then be independently classified and bound into the compact
complete-manifest verifier. Until then, the original observation remains valid
discovery evidence but is not a complete closed-world manifest.

## Required next gates

1. Complete exact-head CI and independent review of the revised observer.
2. Run the revised observer once, directly against Chananya staging, and retain
   its raw output only in restricted evidence storage.
3. Check in a compact reviewed manifest binding every dataset digest and every
   routine/binding disposition; add the distinct closed-world read-only
   verifier status.
4. Repeat exact-head CI and independent review, then run only that read-only
   verifier.
5. Design and review a complete current-ACL/default-ACL remediation. Keep all
   repair and ACL mutations blocked until their separate gate is satisfied.
6. Reconcile Chananya, then independently reconcile Jitarsa, promote approved
   changes in an ordered migration PR, and complete authenticated staging
   regression before any Production gate.
