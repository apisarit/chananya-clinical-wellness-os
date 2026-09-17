# Chananya staging security handoff — 2026-09-17

Status: **review requested; not an approval and not deployment authorization**.

This handoff records the source and staging observations that an independent
security reviewer must inspect before any ACL candidate, migration-ledger
repair, or production promotion is authorized. It intentionally does not mark
any production gate as passed.

## Exact source and target

- Source checkout: `codex/u-synthesize-staging-fix-20260915`
- Source commit: bind at review time with `git rev-parse HEAD`; the reviewer
  must record that exact post-handoff commit in the protected evidence store.
- Staging Supabase project: `hsmnjwxurlmsizndjlun` (`chananya-clinical-staging`)
- Production project was not targeted by the observations or remediations below.
- Production real-patient-data admission remains blocked.

## Changes verified on staging

1. `public.v_clinical_herbal_traceability` uses invoker RLS and no anonymous
   table read is retained.
2. `public.set_updated_at()` has a pinned `search_path = pg_catalog, public`.
3. Direct `PUBLIC`/`anon` table privileges were revoked from the reviewed
   staging application tables and seven public views; authenticated grants
   were preserved where the existing policies require them.
4. Five non-PHI staging fixtures (`TEST-001` … `TEST-005`) are persisted in
   `public.staging_test_case_buffer`. They are editable only through the
   role-checked RPCs, require a reason and optimistic version, and use
   append-only change events with soft-delete/restore.
5. Supabase Auth leaked-password protection is enabled in the staging project
   through the Auth provider settings.

The five fixtures are synthetic staging records, not real patients. No source
change in this handoff authorizes importing them into `patients`, `encounters`,
or any production table.

### Live buffer snapshot (staging only)

The latest read-only query against project `hsmnjwxurlmsizndjlun` observed:

```text
total_rows=5
active_rows=5
event_rows=5
case_keys=TEST-001,TEST-002,TEST-003,TEST-004,TEST-005
versions=1,1,1,1,1
```

The `public.edit_staging_test_case`, `public.remove_staging_test_case`, and
`public.restore_staging_test_case` wrappers are `SECURITY INVOKER` functions.
The authenticated role has no direct table UPDATE privilege but has EXECUTE on
those wrappers; the `anon` role has neither direct table access nor wrapper
EXECUTE. The editor guard still requires an authenticated `admin` or
`super_admin` session. This snapshot is evidence that the editable buffer is
persisted, not evidence of a production approval or of real-patient data.

## Read-only security observations

The current staging advisor snapshot reports:

- 16 RLS-enabled internal tables with no policies. They have no direct
  `PUBLIC`/`anon` table privileges and are intentionally service/internal-only.
- The seven reviewed public views have no `anon` SELECT/INSERT/UPDATE/DELETE
  privileges; authenticated SELECT remains available.
- 81 `SECURITY DEFINER` functions still executable by `anon`.
- 84 `SECURITY DEFINER` functions executable by `authenticated`.
- The leaked-password-protection warning is no longer present after enabling
  the staging setting.

The 81-function ACL candidate remains **inert**. It must not be enabled until
an independent reviewer verifies the complete routine classification, hosted
concurrency assumptions, fresh observer protocol, migration-ledger treatment,
rollback rehearsal, and exact post-commit observation.

## Required independent review actions

- Re-run the read-only observer against the exact source commit and staging
  project, retaining raw output, hashes, stderr, exit code and target identity
  outside the repository.
- Review
  `supabase/manual/202609080900_close_complete_public_routine_acl_candidate.sql`
  and confirm that every unconditional blocker remains fail-closed.
- Verify the candidate does not change function semantics, tenant boundaries,
  trigger behavior, migration history or platform-owned defaults.
- Review the generated rollback rehearsal and run it only in an isolated,
  authorized staging session.
- Record reviewer identity, scope, verdict, timestamp and exact commit in the
  protected evidence store. AI or author-account review is not independent
  approval.

## Non-authorizing local verification

```bash
npm run check
npm run verify:production-promotion
```

The full contract suite passes at the source commit. The production promotion
command must continue to fail closed until a protected external
`PRODUCTION_RELEASE_ATTESTATION_JSON` is supplied. This document does not
change `release-readiness.json`, approve a release, or authorize Production.
