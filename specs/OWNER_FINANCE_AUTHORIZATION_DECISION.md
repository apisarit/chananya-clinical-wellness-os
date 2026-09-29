# Owner financial authorization reconciliation

Status: Owner financial operation approved by the user on 2026-09-27;
source implementation and scoped disposable verification passed. This is not
deployment authorization or hosted acceptance.

## Approved scope and implementation design

The user answered “ใช่ครับ” to allowing Owner to issue invoices and collect
payments. This resolves the Owner choice below, not the separate module-OFF,
refund/credit-note, plain Admin or clinical-access policies.

- Frontend: allow Billing controls for a ready, current clinic Owner context;
  preserve governance-only Admin behavior and existing session invalidation.
- Backend: permit Owner invoice/item/payment read-back only in the active clinic;
  retain existing atomic issue/payment APIs, immutable prices and retry receipts.
- Security: no global governance-admin alias expansion, no direct financial
  table mutation grants, and no new clinical/pharmacy access. Keep inactive
  membership and subscription suspension denials.
- Acceptance: Owner issues, partially/finally pays, reopens invoice/receipt;
  duplicate submission does not duplicate payment; cross-clinic, wrong-role,
  suspended and inactive users remain denied. Hosted acceptance is separate.
Evidence date: 2026-09-27, HEAD 4283e3be plus dirty candidate.

## Current verification

- `npm run check:owner-finance-operations` passed: explicit finance-only Owner
  capability, minimal queue identity projection, failed-refresh invalidation,
  actual SQL queue/receipt RPCs, tenant boundaries, no direct financial writes,
  inactive membership and commercial suspension denials. The actual app-handler
  journey issues an invoice, recovers lost responses, takes payment, renders a
  receipt and closes the original Encounter in disposable SQL.
- `node tests/migration-ledger-contract.mjs` passed with 68 source migrations;
  the new migration checksum is declared in the pending source tail. This does
  not mark the migration applied to a hosted target.
- Payment/service-invoice reload, department persistence and runtime role
  regressions passed. AI-assisted source review found no remaining scoped
  security issue; this is not independent human release approval.
- Logs: `/tmp/cnyos-owner-finance-suite.log`, `/tmp/cnyos-owner-ledger.log`.
- Aggregate `npm run check` passed (`/tmp/cnyos-owner-full-check.log`);
  the Owner suite also passed separately and is now included in `precheck`.
- Production migration, protected release, and authenticated hosted acceptance
  remain outstanding. No real patient data was modified in this change.

## Historical diagnostic before approval — superseded by approved scope above

The following records the original failure and options, not the current policy.
Owner-only financial operation has now been selected; plain Admin remains outside
this change. Current candidate verification is `npm run check:owner-finance-operations`.

### Executable read-back blocker — 2026-09-27 (before remediation)

`npm run check:owner-finance-readback` now runs the same disposable app/SQL
journey with strict Owner quote/read-back checking. Verified exit 1 with
`OWNER_FINANCE_ACCEPTANCE_BLOCKED` after completing the Billing journey and
closing the fixture. Log: `/tmp/cnyos-owner-finance-readback.log`.
The ordinary integration regression still exits 0 with its explicit warning
(`/tmp/cnyos-billing-readback-regression.log`). This separates a passing Billing
regression from the unresolved Owner acceptance; neither is hosted acceptance.
This is a narrow diagnostic, not approval of Owner financial access if someone
later makes the read succeed. The policy choices and full role tests below
still apply. No RLS, financial RPC, production data or release gate was changed.
The owner has been asked to choose governance-only, read oversight, or financial
operation. Do not infer a decision from this diagnostic.

The empty Owner invoice read is not sufficient evidence that SELECT must be
granted. The current layers disagree about financial responsibilities:

| Layer | Current source behavior |
|---|---|
| `chananya-runtime.js` | Owner normalizes to governance Admin; `billing_operate` permits only Billing and Super Admin |
| `app.js` `loadAll` | Invoice/payment loading and billable encounter queries require `billing_operate` |
| Invoice/item/payment RLS | Legacy permissive policies use `has_role(['admin','billing'])`; resolved governance role is `governance_admin`, not `admin` |
| `quote_encounter_invoice` / `issue_atomic_encounter_invoice` | Accept active clinic owner/admin/billing membership |
| `record_atomic_invoice_payment` | Also accepts owner/admin/billing membership; hiding Billing navigation does not remove this RPC permission |

The isolated real-app/SQL integration was re-run and passed its Billing journey,
while reproducing the Owner quote/read mismatch. This does not prove that the
Owner mutation permissions are the desired policy or that Owner acceptance passes.

Choose the intended business role before changing access:
1. Governance-only: keep financial work in Billing; align financial RPC checks,
   including older payment/service wrappers, with this separation.
2. Read-only financial oversight: add an explicitly scoped read capability and UI,
   while denying financial mutations to governance-only accounts.
3. Owner/Admin financial operation: align UI, reads and authorized RPC operations,
   with explicit current-clinic, active membership/subscription and denial tests.

All choices retain Price Master administration, price snapshots, cross-clinic
isolation, audit trails and immutable issued documents. Do not solve this by
globally treating `governance_admin` as every legacy `admin` role: that affects
clinical, pharmacy and other policies beyond finance.

Acceptance after the decision: intended role can complete its allowed journey;
wrong role and cross-clinic attempts fail; OFF/inactive membership fails; direct
RPC calls cannot exceed UI policy; invoice/payment read-back and retry remain
consistent. Real deployment and live acceptance are separate gates.
