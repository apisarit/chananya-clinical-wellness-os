# PHIS-informed OPD → Pharmacy vertical slice

## Baseline and intent

- Release-candidate baseline: `82ded0f9748e147ecbe50019f4e7984a68dd6c84`.
- Use the photographed e-PHIS screens only as evidence of operational concepts: a same-day patient queue, explicit visit ownership, prescription handoff, pharmacy work queues, status colours and traceable operators.
- Do not reproduce proprietary source code, hidden data structures or patient data.
- This slice closes one complete operational journey before more modules are added.

## Problem

The current UI can create a prescription and move it through Pharmacy, but it does not yet prove the account boundaries expected in a real hospital workflow. A same-clinic practitioner can call the prescription RPC for an encounter assigned to another practitioner, and one Pharmacy identity can both review and dispense an order. The audit view does not yet provide a durable from/to history for this handoff.

## Users and responsibilities

- Reception: register/check in a synthetic patient and create the linked encounter; no clinical or dispensing action.
- Assigned practitioner/doctor: document the encounter and release a prescription only for their assigned encounter.
- Pharmacy reviewer: review a waiting order; cannot author clinical data or dispense the order they reviewed.
- Pharmacy dispenser: dispense an already reviewed order using FEFO allocation; must be a different authenticated actor.
- Governance: read the same-clinic immutable event history; cannot perform clinical or Pharmacy actions.
- Super admin: explicit audited emergency override only; never an implicit compatibility path.

## Acceptance criteria

1. A practitioner/doctor with the Clinical department can create a prescription only when `encounters.practitioner_id = auth.uid()`; an explicit `is_super_admin()` override is allowed and audited.
2. Reception, owner/admin, Billing, Pharmacy and an unassigned practitioner are denied by the database RPC. A denied call writes no prescription, dispensing order, stock movement or success event.
3. The Clinical browser lists/selects only encounters assigned to the signed-in practitioner, except for an explicit super-admin session. A stale or forbidden URL encounter fails closed.
4. A prescription creates one waiting dispensing order idempotently. The practitioner cannot review or dispense it.
5. A Pharmacy reviewer can perform only `waiting → reviewed`. Dispense is allowed only from `reviewed`, and `auth.uid()` must differ from `reviewed_by`.
6. FEFO allocation and stock decrement are atomic. Product `conversion_factor` is applied when converting prescribed dispense units to stock units. Insufficient stock rolls back the order, items, lots, movements and success event.
7. Authoritative item price is resolved server-side from the clinic price master. Browser-supplied price is not authoritative.
8. A successful transition appends exactly one immutable event containing clinic, prescription, order, from/to status, actor UUID, effective role, timestamp, reason and request key. Direct event mutation is denied.
9. The Pharmacy queue is re-read after every acknowledged write and remains correct after page reload and account switch. Completed records remain queryable as history.
10. Governance can read same-clinic events with actor and before/after status, but cannot execute the transition RPC. Cross-tenant reads and writes are denied.
11. Staging proof uses synthetic data and separate Reception, Practitioner, Pharmacy Reviewer and Pharmacy Dispenser identities. The API/RPC runner proves authenticated writes, database readback and role-separated transitions without touching a real patient. A separate hosted-browser run must still prove page reload and browser account switching before this criterion is complete.

## Current evidence status

- `scripts/run-staging-synthetic-uat.mjs` produces API/RPC/database evidence only. It does not open or control a browser.
- Its reviewer/dispenser token switch proves server-side account separation, not browser session switching.
- Hosted-browser save → reload/readback and Reception → Practitioner → Pharmacy Reviewer → Pharmacy Dispenser account-switch evidence remains **pending** until captured against the exact staging deploy.
- API/RPC success must not be labelled as complete browser UAT or production readiness.

## Evidence required before production approval

- Exact source commit and exact staging deployment identity.
- Migration list and checksums applied to the isolated staging database.
- Automated contract/database test output, including denial and rollback cases.
- Browser readback after reload and account switch.
- Immutable event rows for the synthetic journey, with actor and status transition.
- Recovery plan and known-good production deploy identity.

## Non-goals for this slice

- Production deployment or admission of real patient data.
- Billing payment/receipt closure, Production, Quality/COA or Marketplace.
- Broad data reset, migration rollback or copying the photographed application.
- Calendar redesign, owner white-label configuration or knowledge publishing.

## Migration and recovery

- Add only forward migrations after the current latest migration; do not rewrite already-applied history.
- Keep the existing RPC names/signatures where possible so the UI can be promoted as the same artifact.
- On failure, stop the feature behind its existing role boundary and apply a reviewed forward remediation migration. Do not blindly roll back data migrations.
