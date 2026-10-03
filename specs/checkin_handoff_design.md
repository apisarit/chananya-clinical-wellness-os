# Check-in handoff — bounded first delivery slice

## Scope and baseline

Preserve the existing appointment register and its assigned-practitioner SQL
linking. Baseline source: `0f65b50740d22ba4a76813bf9b95e4defd8f06b3` (PR68
reviewed tree). Local source changes and isolated synthetic tests only. Production
and real patient data are excluded. No migration, auth-policy change, new role,
controller bypass, deployment or new dependency is part of this slice.

## Reproduced code boundaries

- `patient_checkin` allows reception, but `clinical_write` does not. Check-in
  currently redirects all successful users to the write-gated clinical page.
- The appointment register also renders the clinical record link for reception.
- Switching the identity confirmation does not reset the previous person's
  confirmation checkbox or form values.
- Disabling the submit button is not an in-flight function guard. A known
  successful check-in is not retained if navigation fails or is delayed.

## Frontend

1. Retain a successful check-in receipt on the page; show a persistent, accessible
   completion message and the next permitted action. Reception with an appointment
   returns to its register; a walk-in receipt offers the next check-in and explicit
   provider handoff guidance. Clinical writers may open the returned encounter.
2. Freeze identity selection during submission and prevent overlapping submits.
   Changing identity or cancelling invalidates outstanding identity reads and
   clears consent, verification note and unrelated chief complaint.
3. Never replace a newer selected identity with a delayed QR/search result.
4. A failed/delayed navigation must not issue another creation RPC. Show a link
   that retries navigation only. A denied write must never show success.
5. Unknown transport outcomes are not confirmed failures. Do not automatically
   retry a mutation or describe an uncertain result as safe to resubmit.
6. Clinical links in the appointment register follow the same `clinical_write`
   capability used by the destination. Keep the existing appointment actions and
   server-enforced practitioner ownership; hiding a link is not authorization.

## Backend / compatibility

Keep the existing RPC names and payloads: `check_in_clinic_appointment`,
`confirm_patient_qr`, `start_manual_patient_encounter`. Successful replies supply
`encounter_id` and `patient_id`; retain appointment context without synthesizing
IDs or changing database state from client code. The appointment RPC already
locks and reuses the appointment encounter. This slice does not establish
cross-tab/server idempotency for manual encounters or add automatic readback
against clinical tables that reception cannot access.

## Security checkpoint

- Existing runtime capability checks and database ACL/RLS remain unchanged.
- Validate patient confirmation before mutation; reset it on identity change.
- Use textContent/DOM properties for result text and safe encoded same-origin
  navigation. Do not add real patient content to logs, URLs, local/session storage or
  screenshots. All tests use synthetic records and blocked external requests.
- Keep errors and unknown outcomes visible without claiming a successful save.
- No credential/config extraction or connection to an external database.

## Acceptance

- Reception check-in commits once and offers the appointment queue, not an
  inaccessible clinical editor. Practitioner handoff preserves the exact returned
  encounter ID. Both paths retain a completion link when navigation is unavailable.
- For a walk-in with no appointment, receipt guidance explicitly says there is no
  appointment row. Reception retains the encounter number to hand to a provider;
  the next-patient link opens check-in, not a fabricated appointment queue entry.
  A shared automated walk-in queue is not implemented or claimed by this slice.
- Repeated submission while pending and after acknowledgement sends one RPC;
  navigation retry sends none. Server rejection does not produce a receipt.
- Selecting patient B after confirming A requires fresh consent and clears A's
  note/chief complaint. A delayed response for A cannot replace B.
- Selection/cancellation/QR completion cannot change the active identity during
  an in-flight write. Returned context must match the confirmed patient.
- Original appointment, clinical context and identity contract tests remain green.
- Node regressions and isolated browser tests are local proof only; authenticated
  staging save/reopen/amend remains a separate, unrun acceptance requirement.

## Recovery

No deployed state or migration changes. Review/revert only this scoped local diff
if regression is found; preserve unrelated work. Request release approval once
for the final tested batch, not per implementation/test step.

## Local verification — 1 October 2026

- `npm run check`: passed including precheck, existing workflow, clinical,
  database/RLS and release-policy contracts. These are local tests/fixtures,
  not evidence that the live staging or production environment passed.
- `npm run check:checkin-handoff`: passed 24 appointment role/status/assignment
  cases, 20 actual check-in event-handler VM cases, and six isolated browser
  scenarios. Browser requests are locally fulfilled or aborted; RPCs are synthetic.
- Existing booking refresh, provider browser, appointment operator-read and
  practitioner-capacity regression tests passed. SQL tests use local PGlite.
- Independent AI review reproduced and caught two issues during development:
  a superseded QR read leaving controls disabled, and misleading walk-in queue
  guidance. Both were fixed and retested; final review found no material issues
  in the scoped source/tests. This is technical review, not release approval.
- JavaScript syntax and `git diff --check` passed. No dependency, migration,
  permission, release-policy or production change. No deployable artifact for
  this uncommitted diff is claimed: the publish builder consumes committed HEAD.
- Final screenshot inspection found the initial appointment status remained
  visible after acknowledgement. Replaced that stale label with the confirmed
  encounter handoff (not a fabricated fresh appointment status). Reran the full
  focused handoff suite and post-booking/hybrid identity contracts after this
  display-only delta; independent review found no material concerns. The broader
  `npm run check` pass above preceded this last label correction.
- Still unverified: authenticated staging save/reopen/amend, actual live role
  handoff, camera hardware, reload/cross-tab manual encounter deduplication,
  and automatic shared walk-in queueing. Do not mark these accepted.
