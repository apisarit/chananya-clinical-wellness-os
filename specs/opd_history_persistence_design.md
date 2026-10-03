# OPD history: verified save, reopen and edit

## Outcome / scope

One synthetic OPD-history draft can be saved, reopened in a fresh page, edited
and reopened again under the same encounter without missing or altered fields.
Stop claiming success merely because an upsert returned no error. Preserve the
existing editor, previous worklist/check-in repairs, API, RLS and signoff locks.
This slice excludes treatment-session creation, prescriptions, billing, signed
record unlocking, live data, deployment and whole-visit acceptance.

## Frontend and API contract

- Keep the existing 19 OPD history fields and nullable text/numeric semantics.
  Validate finite, nonnegative numeric input matching the form's step/range;
  zero remains zero, blank remains null. Capture a fixed encounter/revision and
  immutable submitted values before asynchronous work.
- Verify clinical_write before enabling the OPD module and before writes; server
  RLS and locks remain authoritative. Missing/denied auth means no history writes.
- Serialize repeated submissions per encounter. Retain the draft throughout
  write/readback; do not reset it on an error, uncertain result or late response.
- After the existing upsert, perform a new exact-encounter read and compare the
  persisted id/encounter, all 19 fields and writer/time marker. Only matching
  readback may show confirmed success or emit clinical-data-changed.
- Distinguish pre-write rejection, known server rejection and uncertain write or
  readback. Pending/uncertain attempts cannot be blindly resubmitted. A separate
  read-only verification action may reconcile the original captured attempt;
  mismatch/error stays uncertain and does not overwrite the current draft.
- Selection changes cannot retarget a write or put the old encounter's success,
  status or fields into the newly selected encounter. Unknown attempts stay
  blocked for that encounter even after switching away and back within the page.
- Keep drafts in memory only, not browser storage. Error feedback is generic and
  actionable; do not log row values or raw backend errors containing clinical data.

## Data/security/recovery

Reuse public.ttm_opd_histories unique(encounter_id), existing authenticated
select/upsert, tenant access predicates and signoff-lock trigger. No migrations,
privileged clients, grants, RLS changes, dependency changes or new endpoints.
Client checks do not create a transaction or cross-tab optimistic concurrency
control. No server-side retry/idempotency or comprehensive amendment audit is
claimed. Preserve the existing row's created_by; new writes retain current actor.

## Local run manifest

- Run ID: opd-history-local-20261001. Candidate: uncommitted working tree based
  on 0f65b50740d22ba4a76813bf9b95e4defd8f06b3; not an exact release artifact.
- Target: disposable local browser fixtures / local SQL rehearsal only. No live
  origin/project/account, credentials, customer identifiers or remote mutation.
- One synthetic persistence case A plus B for wrong-encounter/denial checks;
  the test owns invented fixtures. One initial save and one amendment; negative
  cases reset only their own local fixture. Browser requests are intercepted.
- Bounds: each asynchronous operation 20 seconds, no automatic write retries;
  deterministic local test suite stops on first failure. Retain red/green evidence.
- Browser fixture can prove UI/controller behavior, not real Supabase OAuth,
  PostgREST/RLS, deployed runtime, staging or customer acceptance. Any SQL proof
  must separately state which actual migrations/policies it executes.
- Live readiness remains BLOCKED at the recorded controller/admission/account
  prerequisites. Live save/reopen/amend: NOT RUN. Cleanup: NOT_NEEDED for live;
  dispose only test-owned browser/in-memory database resources.

## Acceptance

1. All text/numeric/null fields survive save -> fresh page -> one-field edit ->
   fresh page; same row/encounter and untouched fields are retained.
2. No persisted row or different readback cannot show successful save or emit a
   success event. Failed/denied/locked saves retain entered values.
3. Rapid clicks and programmatic submits do not create duplicate in-flight writes.
   Stale responses cannot change the currently selected encounter's UI.
4. Permission/load failure and invalid numeric values prevent writes. Recovery
   verifies only the original exact attempt and never resubmits automatically.
5. Existing OPD encounter-sync and clinical/worklist/check-in tests remain green.

## Evidence and recovery boundary

Use local tests and independent technical review, then append actual results to
the current release checkpoint. Do not update release attestation or promote.
Rollback of this unshipped slice is limited to its source changes; no database
rollback is needed. Real staging persistence and downstream visit completion
remain separate acceptance requirements.

API reference checked: https://supabase.com/docs/reference/javascript/upsert
and https://supabase.com/docs/reference/javascript/maybesingle. A successful
upsert alone is not the independent persisted readback required here.
