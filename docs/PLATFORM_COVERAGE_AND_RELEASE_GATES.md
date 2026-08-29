# Platform Coverage and Commercial Release Gates

Status at PR #7 must be read in four separate dimensions:

1. **Source present** — the route, UI controller, migration or RPC exists in the branch.
2. **Preview visible** — the credential-free review surface demonstrates the workflow with synthetic data.
3. **Staging verified** — the route has passed authenticated testing against an isolated staging tenant.
4. **Knowledge complete** — the source-backed dataset is populated, reviewed and approved; a schema or category placeholder is not completion.

No item may be called production-ready merely because dimensions 1 or 2 pass.

## Platform route coverage

| Legacy / required capability | Current owner | Operational route | Read-only Preview | Current release status |
|---|---|---|---|---|
| Dashboard, patient registry, billing, audit | Operations / Reception / Billing / Admin | `/` | `ui-review.html#operations` | Source present; authenticated staging pending |
| Appointment capacity and booking | Reception; practitioner read | `/appointments.html` | `ui-review.html#appointments` | Source present; authenticated staging pending |
| LINE OA → LIFF QR and HN/manual fallback | Reception / Practitioner | `/api/line-oa-webhook`, `/check-in.html`, `/patient-card.html` | `ui-review.html#checkin` | Messaging callback source present; real signed callback and staging pending |
| Thai medicine knowledge foundation | Practitioner / permitted readers | `/foundation.html` | `ui-review.html#foundation` | Schema present; corpus incomplete; review pending |
| Encounter, OPD, examination, diagnosis, treatment, prescription, sign-off | Practitioner | `/clinical-v3.html` | `ui-review.html#clinical` | Source present; authenticated staging pending |
| Outcomes, pain before/after, follow-up and searchable timeline | Practitioner / Doctor; Super Admin override | `/outcomes.html` | `ui-review.html#outcomes` | Source restored as tenant-bound read-only RPCs; authenticated staging pending |
| Prescription, Product Master, Walk-in Sale, Lot/FEFO, labels | Pharmacy | `/pharmacy.html` | `ui-review.html#pharmacy` | Source present; authenticated staging pending |
| Formula, material issue, batch and stock movement | Production / Inventory | `/production.html` | `ui-review.html#production` | Source present; authenticated staging pending |
| Independent batch review and release | Quality | `/quality.html` | `ui-review.html#quality` | Source present; independent-QC evidence pending |
| Role administration, approvals, audit and amendment | Admin / Super Admin | `/admin.html` | `ui-review.html#admin` | Source present; authenticated staging pending |

Deploy Preview intentionally strips database credentials. Operational routes therefore fail closed. Review navigation must remain inside `ui-review.html` so reviewers can inspect all workspaces without a session, patient data or writes.

## Thai medicine knowledge coverage

| Knowledge set | Current evidence | Status |
|---|---|---|
| Existing rows in `ttm_diagnostic_knowledge` | Imported as traceable legacy concepts by `202608270100_ttm_foundation_ontology.sql` | Preserved after migration |
| Four elements; birth/current constitution distinction; Pitta/Vata/Semha; excess/deficient/disordered; core Samutthan; nine coordinates | Seeded with source and review status | Present, mostly `review_required` |
| Pitta 42 / Vata 80 / Semha 20 disease-symptom sets | Stored only as coverage targets | **Not populated completely** |
| Rupa-dhatu 42 and Thai medicine organ model | Category placeholder | **Not populated completely** |
| Canon, disease, symptom and specialty registries | Schema/category placeholders | **Dataset and citations incomplete** |
| Formula, herb, materia medica, taste and pharmacy-coordinate registries | Schema/category placeholders | **Dataset and citations incomplete** |
| Procedure, Sen Prathan Sip and body-point registries | Schema/category placeholders | **Dataset and citations incomplete** |

Thai Traditional Medicine remains the primary ontology. ICD/WHO is a secondary mapping layer. AI may organize evidence and context but must not diagnose in place of a licensed practitioner.

## Hard commercial release gates

The product must not be described as **Commercial Production ready 100%** until all evidence below is recorded against the exact release commit:

- Authenticated staging E2E passes for every role, including cross-department denials and Super Admin boundaries.
- LINE OA signed Messaging callback, consent, link/revoke, QR issue/expiry/replay denial and HN/manual fallback pass on the staging tenant.
- The first encrypted Google Drive export completes and an isolated restore drill passes with measured RPO/RTO and integrity verification.
- Privacy, security and applicable Thai health-data/legal review are approved with unresolved blockers at zero.
- Required migrations are applied to an isolated staging project and migration/rollback evidence is retained.
- Independent Quality SOP and producer-versus-approver segregation evidence pass.
- Managed database backup/PITR configuration is confirmed separately from Google Drive export.
- Netlify Deploy Preview, automated checks, review status and merge protection pass on the final commit.

The repository includes protected authenticated-staging, real-LINE and isolated managed-restore harnesses plus exact-commit CI evidence. Harness presence is not execution evidence. Until successful exact-commit artifacts are reviewed, the authenticated staging, LINE and restore gates remain `pending`.

Until then, the release label is **Preview / production candidate under verification**.

`release-readiness.json` is the machine-readable release claim. Its `commercialProductionReady` value must remain `false` and each required gate must remain `pending` until evidence tied to the exact release commit has been reviewed. A passing source/Preview test is not evidence that authenticated staging, LINE callback, restore drill or legal review has passed.
