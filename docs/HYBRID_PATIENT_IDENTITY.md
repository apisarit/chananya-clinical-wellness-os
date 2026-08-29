# Chananya Hybrid Patient Identity

This design implements the identity portion of the repository-wide [Product North Star](./PRODUCT_NORTH_STAR.md).

## Product North Star

Chananya Clinical OS must be production-grade, auditable, sellable, scalable, and essential-only. It exists to return time to Thai traditional medicine practitioners and pharmacists, keep access affordable for small providers, and preserve practitioner authority and knowledge development.

Patient identity is therefore **digital-first, never digital-only**:

1. A patient with LINE can show a short-lived one-time QR.
2. A patient without a phone can use an existing HN card or verify name, date of birth, phone, government ID, or guardian relationship with staff.
3. Both routes resolve to the same patient row and create the same encounter record through a transaction-safe database function.

No patient is refused or placed in a lower-quality workflow because they do not own a smartphone.

## Canonical identifiers

- `patients.id`: immutable internal UUID and the clinical foreign key.
- `patients.hn`: human-readable clinic-local HN. The database generates it; the patient does not need to memorize it.
- `encounters.id`: immutable visit UUID.
- `encounters.encounter_no`: human-readable database-generated encounter number.
- `clinic_id`: tenant boundary. Existing rows are assigned to the preserved Chananya legacy clinic during migration.
- LINE `sub`: verified by LINE on the server, then stored only as an HMAC-SHA256 hash.

The QR credential is not an HN. It contains only `CHANANYA:PT1:<256-bit random token>` and expires after 90 seconds. The database stores only SHA-256 hashes of the QR token and six-digit fallback code.

## LINE route

```text
Staff selects patient
  -> staff records consent and the database issues a 12-character link code (15 minutes)
  -> patient opens LIFF Patient Card
  -> Netlify Function verifies the LINE ID token on LINE servers
  -> patient confirms consent and the server HMAC-links the LINE subject
  -> server issues a 90-second one-time QR and six-digit fallback code
  -> authenticated clinic staff scans or enters the code
  -> system displays minimum identity + active allergy warning
  -> staff confirms the person present
  -> database atomically consumes the QR, creates Encounter,
     records verification, and appends audit events
```

## No-phone route

```text
Staff searches HN / name / date of birth / phone
  -> system returns clinic-scoped minimum identity + allergy warning
  -> staff selects verification method
  -> staff confirms the person or guardian present
  -> database atomically creates Encounter,
     records verification method, and appends audit events
```

Guardian verification requires a note. Search audit stores a query hash and result count, not the raw query.

## Security boundaries

- LINE ID tokens are sent to the backend and verified against the configured LINE Login channel. Browser-provided user IDs are never trusted.
- `LINE_LOGIN_CHANNEL_ID`, `SUPABASE_SERVICE_ROLE_KEY`, and `PATIENT_IDENTITY_HMAC_SECRET` remain server-only.
- Patient-facing requests are same-origin, size-limited, rate-limited, and returned with `Cache-Control: no-store`.
- The Patient Card and its Netlify Function must be deployed together on a dedicated patient-only origin that does not share storage with the staff Clinical OS. The LIFF SDK is loaded only after the server reports the feature enabled.
- QR tokens are 256-bit random, one-time, clinic-bound, and expire after 90 seconds.
- Link codes carry 48 bits of randomness, expire after 15 minutes, retry safely on collision, and invalidate previous outstanding codes.
- Both the staff-recorded consent and the LINE account holder's consent are timestamped with the identity link.
- Staff can revoke a link with a required reason; revocation expires outstanding QR credentials and appends both identity and canonical audit events without deleting history.
- A LINE self-link is unique per clinic and patient; the same person may access records at separate clinics without joining their tenant data.
- Six-digit camera fallback codes are collision-checked under a database lock and staff entry attempts are rate-limited.
- Patient name, HN, national ID, allergy, diagnosis, and treatment data are never encoded in the QR.
- Staff must be authenticated, hold a clinic membership, and have a permitted operational role.
- No application `super_admin` receives implicit cross-clinic PHI access. Support access must use an explicit clinic membership; a future break-glass workflow must be time-bound, reasoned, and separately audited.
- Restrictive RLS policies are ANDed with existing role policies for PHI tables to prevent cross-clinic access.
- Patient confirmation, QR consumption, Encounter creation, intake observations, verification, and audit are committed or rolled back together.
- Identity lifecycle events, encounter identity evidence, and the canonical audit ledger are protected by append-only database triggers; corrections must add a new event rather than rewrite history.

## Runtime components

- `patient-card.html` / `patient-card.js`: patient LIFF surface.
- `check-in.html` / `check-in.js`: practitioner/reception mobile scanner and HN fallback.
- `netlify/functions/patient-identity.mts`: server-only LINE verification and QR issuance.
- `netlify/functions/line-oa-webhook.mts`: signed LINE OA Messaging callback and privacy-safe Patient Card routing.
- `supabase/migrations/202608292100_line_oa_messaging_gateway.sql`: callback idempotency, follow state and sanitized identity evidence.
- `supabase/migrations/202608270300_hybrid_patient_identity.sql`: clinic boundary, HN generation, identity records, RLS, RPCs, and audit.

## Required Netlify environment

```text
LINE_LIFF_ID
LINE_LOGIN_CHANNEL_ID
LINE_MESSAGING_CHANNEL_ID
LINE_MESSAGING_CHANNEL_SECRET
LINE_MESSAGING_CHANNEL_ACCESS_TOKEN
PATIENT_IDENTITY_HMAC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Do not put these server-only values into `auth-config.js`. `LINE_LIFF_ID` is public but is served through the configuration response so the patient surface has one activation gate. Patient POST requests are accepted only when the browser `Origin` exactly matches the Function origin; there is no cross-origin allowlist.

`PATIENT_IDENTITY_HMAC_SECRET` is a long-lived identity key, not a routine application secret. Store it in the platform secret manager, restrict access, back it up through the approved operational process, and plan a versioned re-link migration before rotation. Replacing it without migration makes existing LINE links undiscoverable.

The LINE Official Account callback is `/api/line-oa-webhook`. Its Messaging API channel and the LINE Login/LIFF channel must belong to the same LINE Developers provider. The callback validates the official request signature before parsing, stores only keyed/hashes and sanitized action classifications, and never puts patient name, HN, allergy, diagnosis, medicine or appointment detail into chat. See [LINE OA Messaging Gateway](./LINE_OA_MESSAGING_GATEWAY.md).

## Activation and rollback

The migration is additive and preserves legacy HN records. Until it is applied, staff screens remain readable but patient registration and encounter creation fail closed; the browser does not fall back to unaudited multi-table writes. After activation, people without phones continue through HN/demographic/guardian verification using the same atomic encounter RPC. The patient function reports `enabled=false` until all required environment values exist.

Activation order:

1. Apply and test the migration in a non-production Supabase project.
2. Configure a separate non-production LINE Login/LIFF channel.
3. Deploy the Patient Card + Function to a dedicated non-production patient origin, separate from every staff workstation origin, then configure Preview-only Netlify environment values.
4. Test self-link, guardian-link, QR replay, expiry, wrong-clinic access, no-phone search, allergy warning, and encounter rollback.
5. Perform practitioner/reception mobile E2E on iOS and Android.
6. Review PDPA notices, consent wording, retention, revocation, and data-subject request handling with qualified Thai counsel/DPO.
7. Only then schedule Production migration and enable Production environment values.

Rollback is feature-gated: removing the Patient Identity function environment disables LINE issuance while HN/manual workflows continue. Do not delete identity or audit rows during rollback.

## Commercial release boundary

This migration tenant-scopes patient identity and PHI access. A shared-database multi-clinic commercial release still requires tenant scoping and E2E verification for remaining non-PHI operational masters such as product, inventory, supplier, production, and pricing data. It also requires the dedicated patient origin described above. Until those gates pass, deployment should remain one database per licensed clinic or an explicitly isolated pilot environment with LINE identity disabled.
