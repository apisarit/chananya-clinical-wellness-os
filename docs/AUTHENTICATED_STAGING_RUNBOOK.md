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

Verify that `current_access_context()` returns the staging clinic UUID/code before provisioning identities.

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
