# Chananya Clinical OS v3.4 — Access & Clinical Context Stabilization

## Why this release exists

The shared runtime previously preferred `profiles.system_role` over the operational `profiles.role`. A normal user with `system_role = staff` could therefore be resolved as `staff` instead of `practitioner`, `pharmacy`, or `reception`. That could hide navigation or deny a valid workstation before database RLS was evaluated.

## Changes

- Resolve `super_admin` and `admin` as system-level overrides; otherwise preserve the operational role.
- Evaluate capabilities against the applicable system and operational roles while never treating `staff` as an operational grant.
- Reuse the shared Supabase runtime in Clinical, Pharmacy, Production, Appointments, and the main workstation.
- Add Clinical Context & Readiness Guard to Clinical v3.4:
  - patient identity and encounter context;
  - active allergy warning;
  - existing red-flag/examination context;
  - examination, diagnosis, treatment, and sign-off readiness;
  - responsive desktop/mobile layout.
- Strengthen record-lock UX so dynamically added and list-level edit/delete controls are disabled after sign-off. Database triggers remain authoritative.
- Translate common sign-off gate errors into actionable Thai messages.
- Restore `รากวิชา` as a first-class workspace instead of hiding the Thai medicine foundation inside the diagnosis form:
  - five knowledge layers from human model through physical medicine;
  - source, concept, relation, review status, and encounter-binding boundaries;
  - explicit legacy bridge for the existing 23 TTM-DKR rules and Sen placeholders;
  - source/review context visible from the Clinical diagnosis step.

## Database impact

The operational UI and existing Clinical v3.1–v3.3 records require no migration. `/foundation.html` works read-only against the current `ttm_diagnostic_knowledge` and `sen_line_master` tables and clearly labels that state as `Legacy bridge`.

The optional additive migration `202608270100_ttm_foundation_ontology.sql` activates the normalized source → concept → relation → encounter-binding model. It does not replace or copy existing encounter, diagnosis, dispensing, treatment, or audit records. Apply and verify it in a non-production Supabase environment before Production.

## Verification

Run:

```bash
node tests/v34-runtime-role-matrix.mjs
node tests/ia-static-contract.mjs
node tests/ttm-foundation-contract.mjs
```

## Deploy Preview safety

The static Deploy Preview currently uses the same public Supabase project configuration as Production. Do not create, edit, sign, dispense, or delete real patient records from a preview URL.

For authenticated end-to-end verification:

1. Use a dedicated test account and clearly marked test patient/encounter only.
2. Temporarily allow the exact Netlify Deploy Preview callback URL in Supabase Auth redirect configuration if it is not already allowlisted.
3. Remove the temporary preview callback after the release is merged or closed.
4. Treat a successful Netlify build as static-delivery verification, not as proof that authenticated clinical writes were exercised.

Before production merge, verify the Netlify Deploy Preview with these profiles:

1. `system_role=staff, role=practitioner` — Clinical v3.4 opens and can write.
2. `system_role=staff, role=pharmacy` — Pharmacy opens.
3. `system_role=staff, role=reception` — Appointments operator controls appear.
4. `system_role=super_admin` — Admin/Clinical/Pharmacy/Production visibility is available; appointment operation remains read-only by policy.
5. Signed encounter — all clinical mutation controls are disabled except encounter switching and the sign-off status panel.

Production should remain on v3.3.2 until this preview checklist is complete.
