# White-label customer deployment

Status: production foundation. Each licensed customer receives an isolated deployment and an isolated Supabase project. Branding is configuration; clinical, pharmacy and production code is shared and versioned.

This is a white-label product boundary, not a collection of customer forks. A customer launch changes configuration and approved brand assets; it does not copy or hand-edit operational source files.

## What changes per customer

One validated tenant config controls:

- company/clinic names in Thai and English;
- exact app name (`brand.appName`), short brand, mark or logo, exact browser title (`brand.browserTitle`), printed pharmacy identity and color mask;
- expected clinic UUID and code used for HN, prescription, invoice, pharmacy sale and production numbering;
- browser-safe Supabase URL and publishable key;
- OAuth provider, redirect origin and QR issuer.

Use `config/tenant.example.json` as the customer template. Never put `SUPABASE_SERVICE_ROLE_KEY`, Google service-account JSON, backup encryption keys, LINE channel secrets or any other server secret in this file. `scripts/generate-tenant-config.mjs` rejects obvious secret/service-role keys.

### Fast Netlify variable overrides

Routine branding changes should use flat Netlify environment variables rather than hand-editing the full JSON. They override the matching tenant-config values during the build:

| Variable | Controls |
|---|---|
| `CLINICAL_OS_APP_NAME` | Exact name shown on Login and boot screens |
| `CLINICAL_OS_BRAND_SHORT_NAME` | Sidebar, labels and compact identity |
| `CLINICAL_OS_BROWSER_TITLE` | Browser/tab title |
| `CLINICAL_OS_BRAND_NAME_TH` / `CLINICAL_OS_BRAND_NAME_EN` | Legal/display names |
| `CLINICAL_OS_PRODUCT_NAME` | Printed and product identity |
| `CLINICAL_OS_BRAND_DESCRIPTOR` | Sidebar descriptor |
| `CLINICAL_OS_BRAND_MARK` / `CLINICAL_OS_BRAND_LOGO_URL` | Mark or approved logo |
| `CLINICAL_OS_AUTH_PROVIDER` | Supabase OAuth provider identifier, such as `google` |

The structured JSON remains the audited tenant baseline for database, clinic identity, colors and safety guards. A Netlify variable can select an OAuth provider in the application, but the same provider must also be enabled in that tenant's Supabase Auth settings. The Login page probes Supabase before redirecting and displays a controlled configuration error instead of sending users to a raw provider JSON error.

## Isolation model

The commercial default is one Netlify site + one Supabase project + one private Google Drive backup tree per customer. A customer database may contain branches/clinics under the same legal customer only after every operational table has passed tenant-isolation tests. It must never be used as a shortcut to host unrelated customers in the same trust boundary.

The browser config contains `expectedClinicId` and `expectedClinicCode`. After login, the runtime compares both with `current_access_context()`. A site accidentally pointed to another customer's database fails closed: every operational capability remains disabled.

## Customer provisioning

1. Create an isolated Supabase project and apply all migrations in order.
2. Copy `config/tenant.example.json` outside the repository and fill the customer's public branding/database values.
3. Generate and review the one-time clinic bootstrap SQL:

   ```sh
   npm run tenant:bootstrap-sql -- /absolute/path/customer.json > /secure/path/customer-bootstrap.sql
   ```

4. Run that SQL once in the customer's isolated Supabase project. It changes the clinic code/name used by server-authoritative numbering.
5. In the customer's Netlify site, set `CLINICAL_OS_TENANT_CONFIG_JSON` to the complete JSON or set `CLINICAL_OS_TENANT_CONFIG_PATH` to a committed non-secret config path.
6. Configure the customer's OAuth allowlist and server-only function variables. Set `PATIENT_QR_ISSUER` to the same value as `identity.qrIssuer`.
7. Share only the customer's five environment-specific backup folders with that customer's Google service account.
8. Configure the CNYOS Owner allowlist, exact project ref and clinic-code allowlist with Functions-only scope, then prove subscription OFF/ON at the database boundary as documented in `CNYOS_OWNER_CONTROL.md`.
9. Run staging migrations, authenticated role E2E, encrypted export and isolated restore drill before promoting the site.

For a routine new customer, the only customer-specific inputs are the validated JSON configuration, approved logo asset, isolated Supabase project, Netlify site/environment, OAuth/LINE credentials and private Drive folder IDs. No clinical workflow JavaScript, SQL function or role policy should be customized per customer.

`npm run build` validates the config and generates `tenant-config.js` for staff/auth pages plus `brand-config.js` for public/read-only pages. The public brand file contains no database endpoint or key. The staff tenant file contains only browser-safe public configuration.

Netlify Deploy Preview and branch deploy contexts are database-locked by default: the build removes the Supabase URL/key from the generated browser config, so only read-only synthetic review surfaces work. Authenticated staging E2E requires a dedicated staging config, `CLINICAL_OS_ALLOW_PREVIEW_DATABASE=true`, the explicit guard `CLINICAL_OS_PREVIEW_DATABASE_ACK=STAGING_ONLY`, and an explicit customer-specific Production config denylist; using the Production target is rejected by the build.

A dedicated staging Netlify site must set `CLINICAL_OS_STAGING_DEPLOYMENT=true`, even though Netlify labels that site's primary deploy as a `production` context. It remains database-locked until `CLINICAL_OS_ALLOW_STAGING_DATABASE=true`, `CLINICAL_OS_STAGING_DATABASE_ACK=STAGING_ONLY`, an explicit staging config and a Production denylist are all present. The build rejects a matching Production database, site origin, clinic UUID, clinic code or QR issuer.

Manual staging uploads must carry `CLINICAL_OS_REQUIRE_SOURCE_COMMIT=true` plus the exact `CLINICAL_OS_SOURCE_COMMIT`. The generated public `deploy-manifest.json` records commit, tenant identity and whether the browser database is locked. Run `npm run staging:smoke:locked` against the deployed HTTPS origin and retain its JSON result with the release evidence.

The protected 11-role and ten-journey procedure is documented in `AUTHENTICATED_STAGING_RUNBOOK.md`. Its command-line guard independently rejects the Production database/site, matching Production clinic code or QR issuer, and any config without an explicit staging marker. The release gate remains pending until that workflow is executed and reviewed against the exact release commit.

## Release controls

- Production and Deploy Preview use different Supabase projects and test identities.
- A config/database tenant mismatch is a release failure, not a warning.
- Subscription suspension is controlled only through the audited service-role RPC. Tenant bootstrap and customer Admin access cannot reactivate a suspended clinic.
- Customer branding changes must not modify clinical workflow files or database migrations.
- Every customer release records source commit, migration set, config checksum, database project, Netlify site, backup environment, destination tree, key ID and restore evidence.
- The release manifest also records the legal customer name, clinic UUID/code, QR issuer and the approved brand-asset checksum so the deployed mask is auditable.
- Upgrades are promoted from the shared product branch into each customer deployment with the same migration and rollback procedure.
