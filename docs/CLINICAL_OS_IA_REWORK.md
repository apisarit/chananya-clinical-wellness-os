# Chananya Clinical OS — Information Architecture Rework

## Goal

Untangle the operational UI without changing the database source-of-truth. The interface now follows a quiet clinical Thai wellness system: Thai-first, calm, precise, and explicit about who owns each workflow.

## Canonical route boundaries

| Route | Owner | Scope |
| --- | --- | --- |
| `/` | Operations | Today overview, patient registry, billing, audit visibility |
| `/appointments.html` | Admin / Reception | Availability, booking, queue status |
| `/clinical-v3.html` | Practitioner | Encounter, TTM diagnosis, treatment, prescription, sign-off |
| `/pharmacy.html` | Pharmacy | Prescription queue, walk-in, FEFO dispensing, product master |
| `/production.html` | Production / Inventory | Formula, batch, raw material, QC, import |
| `/admin.html` | Admin | Approval tasks, roles, audit, clinical amendment |

The retired localStorage prototype at `/app.html` redirects to `/` and is no longer shipped as a second application.

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

The database boundaries in `CLINICAL_OS_STABILIZATION.md` are unchanged. This rework does not introduce a schema migration and does not copy encounter, diagnosis, dispensing, or treatment data into a new client-side store.

## Known release gates

- Initial encounter creation, patient-plus-allergy registration, prescription handoff, invoice creation, and payment closure still contain multi-table browser writes. They should move to transaction-safe RPCs before the release is treated as fully atomic.
- Authenticated preview testing must use a dedicated test account and test patient because the Deploy Preview currently points at the production Supabase project.
- Verify desktop, tablet, and mobile layout, role visibility, and a signed-record lock before merging.

## Verification

Run:

```bash
node tests/v34-runtime-role-matrix.mjs
node tests/ia-static-contract.mjs
```

`/ui-review.html` is a read-only, no-data visual review surface for the shared shell and clinical workflow. It makes no Supabase requests.
