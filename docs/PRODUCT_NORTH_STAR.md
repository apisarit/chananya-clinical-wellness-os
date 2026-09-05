# Chananya Clinical OS — Product North Star

## Mission

Chananya Clinical OS exists to give Thai traditional medicine practitioners and pharmacists more time for care, knowledge development, and sustainable work. It must remain affordable enough for small providers to access in meaningful volume without accepting lower clinical or security quality.

## Non-negotiable product doctrine

1. **Practitioner time first.** A feature must remove repeated work, prevent a meaningful error, or improve clinical continuity.
2. **Thai traditional medicine is the clinical foundation.** International classifications are mappings and interoperability layers, not replacements for practitioner reasoning.
3. **Digital-first, never digital-only.** LINE and QR can accelerate identity, but HN and staff-assisted workflows remain equivalent for people without smartphones.
4. **One patient, one canonical record per clinic.** UUIDs are internal keys; HN is a clinic-local human identifier; one-time QR credentials are neither.
5. **Human confirmation before clinical consequence.** The system structures evidence and readiness. A qualified practitioner confirms diagnosis, treatment, dispensing, and sign-off.
6. **Essential-only.** No feature ships because it looks impressive. Each new surface needs a named user, a clinical or operational outcome, an owner, and a measurable release gate.

## Production-grade means

“Perfect” is a quality direction, not a claim that software can have no defects. A release may be called production-grade only when there are no known critical blockers and evidence exists for all applicable gates:

- Tenant isolation for every patient, clinical, pharmacy, inventory, production, pricing, and audit path.
- Least-privilege roles with no implicit cross-clinic PHI access, including platform administrators.
- Transaction-safe multi-table clinical and stock operations with tested rollback.
- Append-only, clinic-scoped audit events for identity, consent, clinical sign-off, dispensing, payment, void, and privileged support access.
- Server-authoritative identifiers, counters, timestamps, and irreversible state transitions.
- Secrets confined to managed server environments; patient and staff browser origins isolated where trust boundaries differ.
- Replay, collision, brute-force, expiry, revocation, and concurrency tests for temporary credentials.
- Backup, restore, retention, incident response, migration rollback, monitoring, and support runbooks tested against a non-production environment.
- Responsive and accessible workflows verified on real practitioner devices, with a no-phone and no-camera fallback.
- Legal/DPO review of consent, privacy notice, data-subject rights, retention, and processor agreements before handling live patient data.

## Commercial boundary

- The product is white-label by deployment: customer name, logo, color mask, OAuth origin, clinic code and browser-safe database endpoint are configuration, not forks of clinical code.
- The default commercial unit is one customer Netlify site + one isolated Supabase project + one private encrypted backup destination. See [WHITE_LABEL_DEPLOYMENT.md](./WHITE_LABEL_DEPLOYMENT.md).
- Until every operational master is tenant-scoped and verified, each licensed clinic uses an isolated database/project.
- Patient LINE surfaces use a dedicated patient-only origin and never share browser storage with staff workstations.
- Production data is never used in Deploy Preview. Preview is database-locked unless an explicit separate Supabase project, LINE Login/LIFF channel, test accounts, and synthetic records are configured.
- A release stays Draft until authenticated role E2E, mobile E2E, migration rehearsal, restore rehearsal, and observability gates pass.

## Current identity decision

The authoritative design and activation gates for LINE QR plus HN fallback are in [HYBRID_PATIENT_IDENTITY.md](./HYBRID_PATIENT_IDENTITY.md).

## Current transaction decision

Prescription, invoice, and payment state changes use the database boundary in [ATOMIC_CLINICAL_FINANCIAL_HANDOFFS.md](./ATOMIC_CLINICAL_FINANCIAL_HANDOFFS.md). Browser-side multi-table fallback is prohibited.
