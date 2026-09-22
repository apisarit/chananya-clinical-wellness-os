# Appointment read recovery and release handoff

## Implemented and verified

- Production DB `qptxnrldzzinlcabudjv`, migration `20260922133838`.
- Only `clinic_appointments_staff_read` SELECT predicate changes from the legacy
  reception helper to the existing booking operator helper.
- Current-clinic predicate, linked-patient/practitioner branches, restrictive
  patient tenant boundary, subscription boundary and all write permissions remain.
- Native isolated PostgreSQL regression executes the actual helper and migration:
  active operator reads own clinic; inactive membership and nonmember clinic deny.
- Live authenticated browser: existing appointment visible on 22 September and
  another on 23 September after navigation/read; booked slot shows remaining 1/2.
- No patient record or appointment was created/edited by this verification.

## Publication and reviewer decision required

PR #54 / main `618ed46df741a30030fb41fd8feed87a4336aa25` contains provider-name
mapping and Thai combining-mark search correction. It is merged but not published.
Production deploy run 35731657641 failed exact-commit attestation validation before
publication. Owner approval comment: issue #11, comment 5777470006.

This read-policy change affects authorization and capacity display. It needs a
review of that delta, not a fabricated replacement of the old evidence commit.
Human reviewers must explicitly identify which old signed evidence remains
applicable and which needs fresh proof. In particular access/role, isolation,
migration and security evidence must account for this policy change.

Do not mark all 16 gates passed from the owner comment or these focused tests.
No new live LINE, restore/PITR, incident, legal or clinical review was executed.
No protected attestation secret was changed. The release target must be the final
reviewed merge SHA, not this branch's parent, and post-deploy verification remains.

## Still not proven

- Frontend exact deployed SHA with practitioner labels and Thai search.
- Fresh synthetic booking submit/reopen/readback (existing-row readback only).
- Other live role sessions; upcoming-queue UI remains separate unfinished work.

## Rollback

Restore only the SELECT predicate's `is_reception_or_admin()` branch if necessary;
this reinstates the super_admin read defect. Do not revert clinical data or
disable RLS. Frontend remains at its previously published version.
