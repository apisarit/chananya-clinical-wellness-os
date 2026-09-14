# Platform Coverage and Commercial Release Gates

Status must be read in four separate dimensions:

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
| CNYOS subscription ON/OFF and audit | CNYOS Owner only | `/owner-control.html`, `/api/owner-subscription` | None — control plane is never a synthetic preview | Source present; Google Owner login and live database-enforcement evidence pending |

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

The product must not be described as **Commercial Production ready 100%** until all **16 granular pre-deployment gates** in `release-readiness.json` have retained exact-commit evidence:

1. Google Owner live OFF → existing-session denial → ON recovery and audit.
2. Authenticated staging E2E for all 11 roles, negative cases and synthetic journeys.
3. Bidirectional Chananya/CNYOS ↔ Jitarsa tenant-isolation tests across UI, API/RPC, RLS and database.
4. LINE OA signed callback, consent, revoke, QR expiry/replay denial and manual HN fallback.
5. Encrypted off-site backup creation, checksum, retrieval and retention.
6. Fresh-target isolated restore with reconciliation and measured RPO/RTO.
7. Managed database backup/PITR verification and recovery test independent of off-site export.
8. Production-like migration apply, controlled failure, recovery/rollback and ledger reconciliation.
9. Active production monitoring with tested alert delivery.
10. Witnessed SEV-1 incident-response drill covering containment, rotation, rollback, recovery and reopening.
11. Independent application-security assessment and penetration test with no unresolved Critical/High release blocker.
12. PDPA/privacy/legal review covering DPA, retention, deletion, DSAR, breach response and DPO assessment.
13. Licensed-practitioner clinical-governance approval of knowledge, workflow, dosage safeguards, intended use and limitations.
14. Commercial operations from provisioning/billing/entitlement through SLA/support/upgrade/export/offboarding.
15. Independent Quality SOP and producer-versus-approver segregation.
16. Exact source/deploy provenance, required CI/review, protected main and protected production environment.

The complete acceptance criteria and evidence owners are defined in `docs/PRODUCTION_GATE_EVIDENCE_MATRIX.md`.

The repository includes database-enforced Owner control plus protected authenticated-staging, real-LINE and isolated managed-restore harnesses and exact-commit CI evidence. Source/harness presence is not execution evidence. Until successful exact-commit artifacts are reviewed, every gate remains `pending`.

Until then, the release label is **Preview / production candidate under verification**.

`release-readiness.json` is the machine-readable fail-closed release claim. Its `commercialProductionReady` value remains `false`; production approval is supplied only through the protected external exact-commit attestation. After promotion and deployment for the same commit, the separate public post-deploy attestation must pass before real patient data can be admitted or the owner completion notification can be issued.
