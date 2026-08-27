# Chananya Clinical OS v3.1 Stabilization

## Objective
Stabilize the current Clinical OS before adding more features. Preserve existing clinical, pharmacy, production, billing and appointment data while reducing frontend coupling and migration ambiguity.

## Current source-of-truth boundaries

- `patients`: durable demographic and patient identity data.
- `encounters`: one clinical visit / episode context.
- `ttm_opd_histories`: encounter snapshot of history and lifestyle context used for that visit.
- `clinical_examination_findings`: structured physical examination findings for the encounter.
- `body_pain_points`: structured pain/body-map findings linked to the encounter.
- `ttm_structured_diagnoses`: practitioner-authored structured Thai Traditional Medicine diagnosis.
- `ttm_diagnostic_contexts`: diagnostic knowledge context / Samutthan support record for the encounter.
- `clinical_treatment_plans`: intended care plan.
- `clinical_treatment_sessions`: actual treatment sessions and before/after outcomes.
- Prescription/pharmacy tables: medication ordering and dispensing source of truth. Do not duplicate medicine dispensing in OPD history.

## Existing prerequisites

The current database should already contain these previously-run foundations:
1. `202608011430_clinical_record_v3.sql`
2. `202608151200_ttm_diagnostic_knowledge_layer.sql`
3. `202608172300_opd_encounter_workflow.sql`

## Simplest stabilization install

For a human operator, use one file only:

`supabase/manual/RUN_ONCE_STABILIZATION_V3_1.sql`

It installs both stabilization RPCs and prints the health check at the end.

## Individual migration files (for CI / migration history)

1. `202608252110_stabilize_treatment_sessions.sql`
   - Adds transaction-safe treatment-session creation RPC.
2. `202608251500_atomic_ttm_diagnosis.sql`
   - Saves structured TTM diagnosis and Samutthan context in one database transaction.
3. `202608251430_clinical_os_health_check.sql`
   - Read-only verification query; safe to run repeatedly and should be run last.
4. `202608270300_hybrid_patient_identity.sql`
   - Adds atomic patient registration and LINE QR / HN encounter creation.
5. `202608270400_atomic_clinical_financial_handoffs.sql`
   - Adds atomic prescription, invoice, and payment transitions with server numbering, idempotency, tenant roles, and audit.

## Frontend stabilization rules

1. Use `chananya-runtime.js` as the single shared Supabase client for extension modules.
2. Load Clinical v3 extensions sequentially.
3. Do not replace another module's DOM subtree with `innerHTML` after bindings are installed.
4. Critical multi-table writes must use PostgreSQL RPC/transaction rather than independent browser writes.
5. Role visibility in UI is convenience only; database RLS/RPC remains authoritative.
6. Super Admin may inspect/override where explicitly permitted, but operational ownership remains with Admin/Reception/Practitioner/Pharmacy/Production by workflow.

## Release gate

Do not add new AI/ICD features until the health check reports all required objects present and the Clinical v3 encounter workflow is stable on mobile and tablet.
