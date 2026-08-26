# Chananya Clinical OS — Information Architecture Rework

## Goal

Untangle the operational UI without changing the existing clinical source-of-truth, while restoring Thai medicine's knowledge foundation as a first-class layer. The interface follows a quiet clinical Thai wellness system: Thai-first, calm, precise, and explicit about who owns each workflow.

## Canonical route boundaries

| Route | Owner | Scope |
| --- | --- | --- |
| `/` | Operations | Today overview, patient registry, billing, audit visibility |
| `/appointments.html` | Admin / Reception | Availability, booking, queue status |
| `/foundation.html` | Practitioner / Knowledge | Canon, source, concept, relation, review status, clinical bindings |
| `/clinical-v3.html` | Practitioner | Encounter, TTM diagnosis, treatment, prescription, sign-off |
| `/pharmacy.html` | Pharmacy | Prescription queue, walk-in, FEFO dispensing, product master |
| `/production.html` | Production / Inventory | Formula, batch, raw material, QC, import |
| `/admin.html` | Admin | Approval tasks, roles, audit, clinical amendment |

The retired localStorage prototype at `/app.html` redirects to `/` and is no longer shipped as a second application.

## Thai medicine foundation boundary

The foundation is not another step inside an encounter. It precedes and supports every encounter:

`Canon / Dataset → Concept → Relation → Encounter Evidence → Practitioner Confirmation`

Its five layers are:

1. Cosmology, human model, four elements, and constitution.
2. Functional diagnosis: Samutthan, coordinates, element state, organs, and Rupa-dhatu.
3. Disease, symptom, mechanism, canon, and specialty knowledge.
4. Therapeutic principles, formulas, herbs, tastes, and cautions.
5. Procedures, Sen Prathan Sip, points, and physical medicine.

Thai medicine remains the primary ontology. ICD/WHO is a later mapping layer. AI remains last and may not diagnose in place of a licensed practitioner.

## Clinical workflow

Clinical data is presented as one encounter-bound sequence:

1. Visit intake
2. OPD history
3. Examination and body pain map
4. Thai Traditional Medicine diagnosis
5. Treatment plan, actual session, and outcome
6. Prescription review and Pharmacy handoff
7. Practitioner sign-off and record lock

Thai Traditional Medicine remains the primary diagnostic ontology. Knowledge rules are decision support only; the practitioner confirms the assessment and is authoritative.

## Runtime and UI ownership

- `auth-config.js` contains configuration only.
- `chananya-runtime.js` owns the single Supabase client and capability mapping.
- `app-shell.js` owns global navigation, identity, and the responsive menu.
- Each route owns its static page structure and controller.
- Clinical extension modules mount only inside explicit owned slots or bind to static sections.
- Pharmacy decorators update only their queue action areas and listen to the explicit `chananya:pharmacy-rendered` event; DOM-wide observers are not used.
- Database RLS and RPCs remain authoritative. Hiding a control is not an authorization boundary.

## Preserved source-of-truth

The clinical database boundaries in `CLINICAL_OS_STABILIZATION.md` are unchanged. The additive `202608270100_ttm_foundation_ontology.sql` migration normalizes sources, concepts, terms, relations, and encounter bindings; it does not copy or replace encounter, diagnosis, dispensing, or treatment data and introduces no client-side source of truth. Until that migration is applied, `/foundation.html` uses the existing `ttm_diagnostic_knowledge` and `sen_line_master` tables as an explicit legacy bridge.

## Known release gates

- Initial encounter creation, patient-plus-allergy registration, prescription handoff, invoice creation, and payment closure still contain multi-table browser writes. They should move to transaction-safe RPCs before the release is treated as fully atomic.
- Authenticated preview testing must use a dedicated test account and test patient because the Deploy Preview currently points at the production Supabase project.
- Apply and verify the foundation migration in a non-production Supabase environment before enabling ontology-backed encounter bindings. The Preview fallback is read-only.
- Verify desktop, tablet, and mobile layout, role visibility, and a signed-record lock before merging.

## Verification

Run:

```bash
node tests/v34-runtime-role-matrix.mjs
node tests/ia-static-contract.mjs
node tests/ttm-foundation-contract.mjs
```

`/ui-review.html` is a read-only, no-data visual review surface for the shared shell and clinical workflow. It makes no Supabase requests.
