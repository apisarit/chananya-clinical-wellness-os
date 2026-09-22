# Practitioner-first appointment pilot hotfix

## Scope

Based on merged PR #56 (`4561db1b9441065d233cb5b17cf0f42df9cdd1d5`).
Booking now selects practitioner → available date → time → branch/room →
patient. Only existing authorized provider directory entries and returned
availability rows are used; no provider, room, appointment or permission is
created by this UI change.

Dependent selections reset when an upstream choice or availability search
changes. Same room codes in different branches remain distinct. Missing
availability is explained; providers with no schedules still appear. Before
calling the existing booking RPC, the selected schedule must match all four
selectors. Direct card selection and newly created schedule auto-selection
remain supported.

## Technical verification

- `node tests/appointment-scheduling-contract.mjs`: synthetic Node/PGlite
  contracts exercise filtering, exact schedule resolution, resets and stale
  responses, plus previous permission regressions.
- `tests/appointment-provider-browser.mjs`: actual HTML/JavaScript in a fresh
  headless Chrome context, with all network aborted and in-memory synthetic
  RPCs. Clicks through all selectors, distinguishes branches, rejects a
  mismatched hidden schedule, submits exactly one simulated appointment and
  reloads its list. This is **SIMULATION ONLY**, not live database persistence.
- Optional local browser command: set `CNYOS_TEST_BROWSER_PATH` to an installed
  compatible Chrome executable, then run the browser test with Node. CI may
  use Playwright's installed Chromium without that override.

## Unchanged boundaries and remaining acceptance

- No schema, RLS, release-policy, database target, credential or production
  runtime configuration change. No live records changed.
- Room options are preconfigured schedule rooms with available capacity,
  not a new global room-occupancy engine. Existing backend exact-schedule
  locking/capacity checks remain authoritative. This does not establish
  cross-schedule room conflict prevention.
- Jaoball is Chmixball Th per owner confirmation. No Jaoball schedules were
  invented or copied from Chayaporn.
- Live acceptance on `cnyos.cloud` still requires reviewed publication and an
  authorized synthetic identity with notification isolation: select → save →
  leave/reopen → read the same appointment ID back from production.

## Reviewer and release handoff

This is AI-assisted implementation and technical evidence, not independent
release approval. Review this bounded pilot delta; after merge use the actual
merge SHA for the release record. Prior approvals must retain their original
SHA and evidence timestamps. Any decision that prior evidence remains
applicable must explicitly identify the new target and residual limitations;
do not relabel missing tests as newly executed. The existing protected release
workflow and reviewer requirements remain unchanged.
