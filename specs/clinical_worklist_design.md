# Clinical encounter worklist — visit-centred CNYOS

## Outcome and boundaries

Give an authorized clinician a legible worklist to find an existing visit after
check-in, including encounter-only/walk-in records, without re-entering identity.
Retain the existing editor and working appointment register. This is one part of
the outpatient replacement journey, not a whole-system replacement or release.

The approved source baseline remains PR68; prior local check-in repairs are
preserved. Production remains unchanged/on hold. No customer source images,
identifiers or confidential reference notes belong in this repository.

## Frontend

- Add a collapsible clinical worklist above the existing editor. Show it expanded
  when no encounter is selected, collapsed when an exact encounter deep link is
  opened. Keep the existing selector available.
- Display HN/name, encounter number, start time, stored status and chief complaint.
  Filter the authorized loaded snapshot by Bangkok calendar date, search text and
  stored status. Counters explicitly describe the loaded/filtered snapshot, never
  a complete clinic census. At the 250-encounter limit show a truncation warning.
- Do not reinterpret encounter start as arrival/waiting time, or draft/completed
  as triage, pharmacy readiness, financial settlement or clinical safety.
- Unknown statuses and missing patient names remain visibly unknown. No inferred
  allergies, urgency, diagnosis, provider assignment or business completion.
- Open the selected encounter's existing history route in a clearly labelled new
  tab; this deliberately preserves unsaved work in the current editor. Use an
  encoded exact ID and same-origin path with noopener. No new encounter creation.
- Refresh only the worklist snapshot, not the editor/selection/drafts. Repeated
  refresh clicks are bounded while pending. Failed refresh invalidates actionable
  rows and counts until a successful retry; do not display stale rows as current
  or turn permission failure into an empty successful queue.
- Use text/DOM output, labels, live feedback, text alongside status badges, and
  a mobile-safe horizontally scrollable table. No PHI in logs or browser storage.

## Data / API / security

Reuse the current authenticated client and RLS-scoped reads. Encounter fields:
`id,encounter_no,patient_id,chief_complaint,thai_diagnosis,started_at,status`, ordered
by started_at descending, limited to 250. Patient identity snapshot is already
bounded to 500 rows by the editor; refresh may select only name/HN/id fields.
No privileged client, new grant, migration, schema, RPC, role or dependency.
Missing identities are labelled, not fabricated or fetched outside those limits.
Mount only after the existing clinical_write authorization passes. Frontend
filtering is convenience, not tenant isolation or a substitute for RLS.

The worklist accepts {encounters, patients, loadedAt}; validates arrays and row
identities; catches read errors with generic recoverable feedback. It owns a
read generation/lifecycle token so superseded responses/page exit cannot revive
old data. The controller exposes update, loading, failure and destroy boundaries.
The view itself performs no writes or RPCs and cannot alter editor state. Browser
cache restoration revalidates the original user, clinic and clinical_write
capability before remounting and issuing fresh bounded reads via its refresh API.
It does not rerun editor initialization or overwrite unsaved drafts. Repeated
page exits and superseded authorization results invalidate restoration.

## Acceptance / proof

1. A synthetic checked-in/walk-in encounter is findable by HN, name and number;
   the link preserves its exact ID and opens the existing history route.
2. Date filtering uses Asia/Bangkok even near UTC midnight; status is explicit,
   unknown values remain visible, and empty matches differ from failed reads.
3. Counters follow the current filters and disclose the 250-row cap; missing
   patient identity is visible and cannot be confused with another patient.
4. Refresh cannot change the selected encounter, entered note, prescription
   draft or editor URL. Pending duplication, failure/retry and stale result
   handling are exercised using isolated browser fixtures.
5. Denied clinical roles do not mount the view or request clinical data. Strings
   are rendered as text, not executable markup. No external egress in tests.
6. Existing clinical selection, prescription and check-in regressions remain green.

Use synthetic automated tests and local browser screenshots; distinguish these
from authenticated staging persistence or customer acceptance. Save/reopen/amend,
pharmacy/stock, finance and real UAT retain their separate incomplete acceptance.

## Recovery / delivery

No deployed/data change. Remove only this component/integration to revert this
slice; preserve existing editor and earlier local repairs. Batch actual evidence
before one final release review; do not manufacture an attestation or deploy.

## Verification record — 1 October 2026

- `tests/clinical-worklist-integration.mjs` exercises the actual clinical controller
  with a synthetic view boundary: authorized mount, denied roles/session, bounded
  read-only refresh, strict response failure, and preservation of selected
  encounter, URL, notes, treatment plan and prescription cart. It also covers
  browser-cache event restoration, changed user/clinic/role, and late auth results.
- `tests/clinical-worklist-browser.mjs` exercises the real worklist component and
  page markup with isolated synthetic data. It is not a live backend/UAT proof.
- Independent technical review identified browser-cache restoration as a defect;
  corrected and focused integration tests rerun successfully. No human release
  authorization is implied.
- No new schema, migration, privilege, dependency or write endpoint. Existing
  authorized snapshot limits remain: 250 encounters / 500 patient identities;
  this is not a paginated clinic-wide search, assigned-doctor queue, disposition
  engine or verified pharmacy/payment status display.
- Source is uncommitted; the committed-HEAD publisher must not be used as evidence
  that these changes were built or deployed. Real save/reopen/amend and complete
  appointment-to-pharmacy-to-finance acceptance remain outstanding.
