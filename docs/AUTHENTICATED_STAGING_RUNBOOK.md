# Authenticated staging release gate

Status: harness present; execution evidence pending. This runbook does not authorize a Production target and does not mark the commercial release gate as passed.

The protected workflow verifies the exact release candidate against a dedicated Netlify site and a dedicated Supabase project. It provisions synthetic identities, checks database authorization for every role, loads every workspace in a real mobile Chromium session, and runs ten synthetic Practitioner → Pharmacy → Billing journeys through full payment and Encounter closure.

## Isolation requirements

Before any run, create a staging boundary with all of the following:

- a Supabase project that is not the Production project;
- a Netlify site/origin that is not the Production site;
- a deployment ID containing `staging`, `stage`, `nonprod` or `test`;
- a clinic code and QR issuer that differ from Production;
- synthetic accounts and records only;
- the complete ordered migration set applied to staging;
- OAuth/LINE callback allowlists containing only the staging callback origins used for testing.

The command-line guard requires an explicit Production config denylist for the licensed customer. It rejects the Production Supabase origin, Production site, Production clinic code, Production QR issuer, non-staging deployment IDs, HTTP origins, missing acknowledgement, and a mismatch between `STAGING_SITE_URL` and the staging config redirect origin. This prevents a white-label customer from being compared only with Chananya's target. It never prints passwords, service-role keys or session tokens.

Use `config/tenant.staging.example.json` as the public configuration template. Replace the placeholder Supabase URL, publishable key and site origin outside the repository. Apply the migrations and then generate/run the tenant bootstrap SQL against the isolated project:

```sh
npm run tenant:bootstrap-sql -- /absolute/path/tenant.staging.json
```

The bootstrap is idempotent: it creates the configured clinic UUID on a fresh database or updates that same UUID, fails on a clinic-code collision, and never re-keys the canonical clinic row seeded by the migrations. A successful run returns `CHANANYA_TENANT_BOOTSTRAP_READY` with the staging deployment and clinic identifiers.

After the clinic bootstrap succeeds, provision the 11 synthetic staging identities. Then verify that `current_access_context()` returns the staging clinic UUID/code for each identity.

### One-time migration ledger recovery

If the schema was installed manually before the Supabase CLI migration history was initialized, do not simply mark filenames as applied. First apply every genuinely missing migration, run the tenant bootstrap, and provision the 11 synthetic identities. Only then generate the guarded recovery SQL from the exact release candidate:

```sh
CLINICAL_OS_SOURCE_COMMIT=<exact Git SHA> \
npm run --silent migration:ledger-repair-sql -- /absolute/path/tenant.staging.json > /secure/path/staging-ledger-repair.sql
```

The generated transaction fails closed unless the staging clinic, active membership and Super Admin created by provisioning all match; transactional patient/Encounter/invoice/payment tables are empty; the complete schema and RLS fingerprint is present; all final database health checks pass; and the ledger has no conflicting rows. It then initializes the canonical `supabase_migrations.schema_migrations(version, statements, name)` shape and records every ordered migration with a source-file SHA-256 evidence statement. A successful run must return `CHANANYA_STAGING_MIGRATION_LEDGER_READY` with the repository migration count and exact first/last versions.

Required first-time order: ordered migrations → tenant bootstrap → 11-role provisioning → migration-ledger recovery → authenticated E2E. Do not run the ledger repair before provisioning; its membership and Super Admin guards will reject that sequence.

This recovery is staging-only. Never run it against Production, never use it to conceal a failed migration, and never backfill history after real patient or transactional data has been introduced.

## Protected GitHub environment

Create a GitHub environment named `staging` and require a reviewer. Configure:

| Type | Name | Purpose |
|---|---|---|
| Secret | `CLINICAL_OS_STAGING_CONFIG_JSON` | Complete browser-safe staging tenant config |
| Secret | `CLINICAL_OS_PRODUCTION_CONFIG_JSON` | Customer's browser-safe Production config, used only as a denylist |
| Secret | `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Server-only provisioning and evidence reads |
| Secret | `STAGING_TEST_PASSWORD` | Shared password for synthetic test identities; minimum 16 characters |
| Variable | `STAGING_SITE_URL` | Exact HTTPS origin of the isolated staging site |
| Variable | `STAGING_TEST_EMAIL_DOMAIN` | Domain used only for synthetic Auth users |

The service-role key and password must not be configured in Netlify browser variables or committed files. The staging Netlify deployment separately needs its browser-safe tenant config and the preview database guards described in `WHITE_LABEL_DEPLOYMENT.md`.

For a dedicated staging Netlify site, set `CLINICAL_OS_STAGING_DEPLOYMENT=true`. Its primary deploy is still treated as non-production by the application guard and remains database-locked until the staging database acknowledgement and Production config denylist are supplied.

Every manual staging build must also set `CLINICAL_OS_REQUIRE_SOURCE_COMMIT=true` and `CLINICAL_OS_SOURCE_COMMIT=<exact Git SHA>`. The build publishes a credential-free `deploy-manifest.json`; a missing or malformed required revision fails the build. After deployment, verify the public locked boundary before adding any database credential:

```bash
STAGING_SITE_URL=https://chananya-clinical-staging.netlify.app \
EXPECTED_STAGING_SOURCE_COMMIT=<exact Git SHA> \
npm run staging:smoke:locked
```

The locked smoke gate checks source provenance, tenant/database lock, security headers and all 11 public route shells. It is useful deployment evidence but does **not** satisfy the authenticated staging gate.

## What the workflow proves

The manual workflow `.github/workflows/authenticated-staging-e2e.yml` performs:

1. the complete source and embedded Postgres behavioral suite;
2. provisioning of 11 synthetic identities: Practitioner, Doctor, Reception, Pharmacy, Production, Inventory, Quality, Billing, Admin, Super Admin and Viewer;
3. exact `current_access_context()` tenant/role verification for each identity;
4. the complete `department_can()` allow/deny matrix, including the rule that only Super Admin receives cross-workspace access;
5. all 10 workspace routes in mobile Chromium for every role, including denied-route behavior and visible navigation;
6. migration health checks for hybrid identity, clinical/financial handoffs, prescription dispensing, production and independent Quality;
7. ten synthetic patient journeys through registration, manual-HN identity fallback, Encounter, Thai medicine diagnosis, prescription, Pharmacy review, FEFO lot allocation, Billing, payment and Encounter closure;
8. negative segregation checks and required audit actions;
9. JSON evidence and failure screenshots retained against the exact Git commit for 90 days.

The workflow intentionally creates synthetic staging records. Run it only after the protected environment reviewer confirms the target project and site.

## Evidence and release decision

A successful run produces:

- `staging-user-provisioning.json`;
- `authenticated-staging-matrix.json`;
- `authenticated-staging-synthetic-uat.json`;
- a screenshot for any browser failure.

Do not change `release-readiness.json` from `pending` based only on the presence of this harness. The authenticated staging gate may move to `passed` only after a reviewer checks the successful workflow URL, exact source commit, staging project ref, tenant code, role count, route matrix, ten journey results and unresolved failures at zero.

LINE callback/replay tests, encrypted Google Drive backup + isolated restore drill, managed database backup/PITR confirmation, and privacy/security/legal review remain separate hard gates.

The LINE gate must use the signed Messaging API callback described in `LINE_OA_MESSAGING_GATEWAY.md`, not only a locally supplied LINE ID token. The exact staging deploy must report `enabled=true` at `/api/line-oa-webhook`, pass LINE Developers **Verify**, receive a real event from the dedicated test account, and retain non-PHI `line_oa_webhook_evidence(...)` with the LIFF/QR/revoke/HN evidence.

For the backup gate, use only the `00-staging-environment` Drive tree documented in `DEPARTMENT_ACCESS_AND_BACKUPS.md`. The transaction/audit export is a fourth encrypted domain, and its manifest must report `environment=staging`, the exact source revision and zero failed domains. Do not share or configure the Production Drive tree in the staging Netlify site.
