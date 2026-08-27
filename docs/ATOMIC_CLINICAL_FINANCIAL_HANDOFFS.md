# Atomic Clinical and Financial Handoffs

## Why this boundary exists

Prescription handoff, invoice issuance, and payment closure each change more
than one authoritative table. They must never be assembled from independent
browser writes because an interrupted request can leave a clinically or
financially incomplete record.

`202608270400_atomic_clinical_financial_handoffs.sql` moves these three
boundaries into PostgreSQL transactions:

| Workflow | Transactional result |
| --- | --- |
| Practitioner sends prescription | Prescription, items, pharmacy queue, server reference, audit |
| Billing issues invoice | Server-derived medicine lines, service line, total, order state, audit |
| Billing records payment | Payment, recalculated invoice balance, encounter closure, audit |

## Safety properties

- Clinic membership and workflow role are checked inside each `SECURITY DEFINER` RPC.
- Encounter, dispensing order, and invoice rows are locked during state transitions.
- RX, queue, invoice, and payment references come from clinic-scoped server counters.
- Prescription and payment request keys are idempotent. A retry returns the
  original committed result; reuse with different input fails closed.
- Invoice totals are derived from authoritative `dispensing_items`; the browser
  only supplies service fee and discount.
- Prescription units must match Product Master `dispense_unit`.
- Audit evidence commits in the same transaction as the operational record.
- Direct authenticated writes to prescription, invoice, and payment records are
  revoked; the browser can only use the RPC boundary.
- If the migration health check is unavailable, the UI remains readable but
  blocks these writes instead of falling back to partial browser operations.

## Verification

Run the full contract and PostgreSQL behavioral suite:

```bash
npm run check
```

The PGlite behavioral test proves:

- one committed row set under idempotent retry;
- full rollback when a prescription item is invalid;
- server-derived invoice totals and one invoice per dispensing order;
- partial payment without encounter closure;
- overpayment rollback;
- final payment and encounter closure in one transaction;
- direct table-write denial and one audit event per committed action.

## Activation gate

Apply this migration only after `202608270300_hybrid_patient_identity.sql`, in a
dedicated non-production Supabase project with synthetic data. Verify the health
check, each permitted role, permission denial, concurrent retry, and migration
rollback before Production. The static Deploy Preview must not be used to run
this migration against the shared Production database.

## Remaining commercial boundary

This migration closes the clinical-to-financial browser-write blocker. It does
not make the whole product commercially multi-tenant. Product, supplier,
inventory, production, and pricing records still require clinic scoping, and
production/material/QC state changes still require dedicated atomic RPCs. Until
those gates pass, use one isolated database/project per licensed clinic.
