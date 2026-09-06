# CNYOS Platform Console

The Owner workspace at `/platform-console.html` builds and stores customer website plans: app name, existing site, copied Supabase / Drive / NAS links, and a dependency-aware selection of nine product modules. It extends the existing Owner boundary. It does not create a hidden administrator or a universal patient-data role.

## What is implemented

- Google Owner authentication reuses the audited server validation, including additional Google proof for linked OAuth identities. An explicit server-side user UUID allowlist is also required for Platform Owner. Clinic `admin` or `super_admin` does not satisfy that check.
- The platform endpoint accepts requests only on its exact, published primary Netlify site. It rejects previews, copied sites, cross-origin requests and unknown input fields.
- Validated non-secret plans and their actor/time/source hash are stored in a site-scoped Netlify Blob. Each save creates an immutable revision. Conditional writes prevent request-ID reuse and duplicate dispatches. The API has no plan-delete or audit-edit operation.
- Drive folder URLs/IDs and Supabase dashboard URLs/API origins are normalized. Credential-bearing URLs are rejected. NAS HTTPS endpoints can be recorded for connector setup. The endpoint never fetches arbitrary pasted URLs, follows their redirects or treats a link as authorization.
- Optional modules are removed from the built customer package and its navigation. Required dependencies are included. Existing tenant configurations that have no explicit feature selection retain their complete current package. Module packaging is separate from the existing database role/RLS authorization; it is not a new database license-enforcement mechanism.
- The deployment button dispatches only an immutable saved **draft preview** plan to the fixed shared repository/workflow, after a Google OAuth authentication within the last 15 minutes. There is no arbitrary repository, workflow, branch, shell command, secret or production-gate override in the browser input.
- The protected `platform-preview` GitHub Environment supplies an independent target registry and its own Netlify credential. The workflow revalidates the exact main commit, plan hash and target; runs the existing product/security checks; builds a locked database configuration; and deploys a draft without tenant Functions. It checks exact live files, omitted pages, source/feature manifest and that the primary published deployment has not changed.
- A queued or successful workflow is labelled as such. It is not labelled as a live clinical production release. Ambiguous dispatch failures are retained and are never automatically resent.

## Platform activation

These are Functions-only values on the designated platform site, not on every clinic site:

| Variable | Purpose |
| --- | --- |
| `CNYOS_PLATFORM_CONTROL_ENABLED=true` | Enable the new endpoint after review |
| `CNYOS_PLATFORM_OWNER_USER_IDS` | Exact, already-authorized Google Owner Supabase user UUIDs |
| `CNYOS_PLATFORM_TARGETS_JSON` | Reviewed registry of independently isolated customer targets |
| `CNYOS_PLATFORM_GITHUB_TOKEN` | Optional secret with Actions write/read permission limited to the shared repository; required for dispatch/status |

The endpoint additionally requires all existing `CNYOS_OWNER_*` project/site/email pins, the platform site's own server-only `SUPABASE_SERVICE_ROLE_KEY`, and the exact 40-character `CLINICAL_OS_SOURCE_COMMIT`. No tenant service key or storage credential is accepted through the plan form.

One registry row has the following structure (synthetic example only):

```json
{
  "key": "example-staging",
  "label": "Example Clinic",
  "siteId": "22222222-2222-4222-a222-222222222222",
  "siteOrigin": "https://example-staging.netlify.app",
  "clinicId": "33333333-3333-4333-a333-333333333333",
  "clinicCode": "EXAMPLE-STG",
  "projectRef": "abcdefghijklmnopqrst",
  "environment": "staging",
  "driveRootId": "synthetic_folder_12345678"
}
```

The registry rejects repeated customer database refs and site IDs. Creating a paid project or assigning an unrelated customer's database is not an automatic side effect of saving a plan. The future Jitarsa production shell must stay unregistered until it has its own reviewed database/configuration.

For preview dispatch, configure the GitHub Environment **`platform-preview`**:

1. Protect deployments to `main` and apply the intended reviewer policy.
2. Set variable `CNYOS_PLATFORM_PREVIEW_TARGETS_JSON` to the independently reviewed target registry.
3. Set the scoped `NETLIFY_AUTH_TOKEN` secret for those existing sites.
4. Supply the repository-limited Actions credential to the platform site's Functions as `CNYOS_PLATFORM_GITHUB_TOKEN`.
5. Run a synthetic saved plan, verify the live draft evidence and review the unchanged published primary site. Never infer readiness from a token-presence indicator alone: credential permissions are established by a successful job.

The UI remains usable for validated drafting when the deployment connection is missing. It displays the blocker and disables dispatch. Missing external credentials are not fabricated, copied from another clinic or exposed in the browser.

## Connections that still require implementation/provisioning

**Google Drive:** the existing Owner Drive endpoint remains the actual audited assignment route. To use the user's existing My Drive folders unattended, add an Owner OAuth adapter, protect refresh-token storage and implement refresh/revocation handling. Alternatively provision the existing service-account adapter against an appropriate Shared Drive. A pasted root link is an identifier, not evidence of write access, encryption or restore capability. The platform plan never changes `BACKUP_ENABLED` or `CNYOS_OWNER_DRIVE_ENABLED`.

**Database:** this release recognizes Supabase links. Other databases require a separately implemented and tested adapter; arbitrary JDBC/Postgres connection strings and passwords are not accepted. New database provisioning, migration-ledger reconciliation and verified user onboarding remain explicit infrastructure tasks.

**NAS:** recording an endpoint does not implement NAS I/O. Before activation, choose and implement a scoped WebDAV/S3/agent connector, use protected credentials, pin destinations and validate network/redirect restrictions. Private LAN endpoints need an outbound connector or an explicitly configured private network. Do not expose the NAS administration console or accept a share URL as proof of backup capability.

**Production:** actual clinical publication keeps the existing exact-source production approval, authenticated role tests, migration/isolation checks, encrypted backup/restore evidence and rollback procedure. This preview workflow cannot publish primary production. Stronger MFA/step-up enrollment, time-limited support roles, dual approval for destructive recovery and independently retained audit/alerting are further platform controls, not capabilities claimed by this release.

## Verification

`npm run check:platform` exercises the API with synthetic identities/transports: owner vs clinic-admin denial, copied-site/preview/CSRF denial, input validation, immutable plans, exact source, stale Google sign-in, concurrent dispatch, unknown transport outcome, independent workflow target validation and physical omission of unselected pages. It does not create Auth users or read patient records.

Run the full existing `npm run check` before merging. A real signed-in browser save and a successful connected GitHub/Netlify preview job remain separate live acceptance checks; passing simulated transports must not be represented as those checks.

References: [Google server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Netlify conditional Blob writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
