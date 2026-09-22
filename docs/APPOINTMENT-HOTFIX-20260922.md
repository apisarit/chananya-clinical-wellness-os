# Appointment live recovery — 2026-09-22

Target: https://cnyos.cloud/appointments.html; production database qptxnrldzzinlcabudjv.
Frontend baseline: a02593d8196001cd59641d59e1573fb2eab12cae.

Applied database migrations:
- 20260922101632: provider RPC VOLATILE, retaining subscription lock and ACL.
- 20260922102422: optional profile join in security-invoker availability view.

Live authenticated super_admin observation: boot recovered; 48 slots returned
for the selected date/time filters; selecting a slot populated booking section 2.
No patient appointment created or changed by this verification.

Local frontend follow-up: resolve provider display names from existing authorized
RPC before loading availability; preserve Unicode combining marks in patient search.
These frontend edits require protected publication and live re-verification.

Regression: PGlite executes the actual view migration with profile rows hidden by
RLS and verifies own-clinic schedules survive, other-clinic schedules remain hidden,
and profile access stays denied. Synthetic Thai search strings retain combining marks.

Not proven: booking submission/readback, concurrent capacity, all-role live coverage.
Do not infer production readiness from these focused checks.

Database rollback: restore the prior inner join if necessary (would reinstate the
reported visibility bug). Reverting provider RPC to STABLE reinstates the read-only
transaction failure. No patient data/schema columns were modified.
