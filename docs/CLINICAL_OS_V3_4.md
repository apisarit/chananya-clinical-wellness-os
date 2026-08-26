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

## Database impact

No migration is required. This release reads existing v3.1–v3.3 tables and RPCs only.

## Verification

Run:

```bash
node tests/v34-runtime-role-matrix.mjs
```

Before production merge, verify the Netlify Deploy Preview with these profiles:

1. `system_role=staff, role=practitioner` — Clinical v3.4 opens and can write.
2. `system_role=staff, role=pharmacy` — Pharmacy opens.
3. `system_role=staff, role=reception` — Appointments operator controls appear.
4. `system_role=super_admin` — Admin/Clinical/Pharmacy/Production visibility is available; appointment operation remains read-only by policy.
5. Signed encounter — all clinical mutation controls are disabled except encounter switching and the sign-off status panel.

Production should remain on v3.3.2 until this preview checklist is complete.
