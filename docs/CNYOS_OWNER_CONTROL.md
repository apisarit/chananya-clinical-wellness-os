# CNYOS Owner Subscription and Drive Safety Console

Status: source implementation present; staging activation and live ON/OFF evidence are required before the commercial gate may pass.

The Owner Console is a CNYOS control-plane route at `/owner-control.html`. It controls database-enforced subscription state and the encrypted-backup Drive destination. It does not grant either operation to a customer administrator. Access requires all of the following:

- a valid Supabase user session created through Google;
- a confirmed email address in the server-only `CNYOS_OWNER_EMAILS` allowlist;
- the exact Supabase project ref in `CNYOS_OWNER_EXPECTED_PROJECT_REF`;
- the exact clinic code in `CNYOS_OWNER_CLINIC_CODES`;
- `CNYOS_OWNER_CONTROL_ENABLED=true` in the Netlify Functions runtime.

The browser receives only the normal Supabase publishable key and its user session. `SUPABASE_SERVICE_ROLE_KEY` stays in the Netlify Function and must have Functions-only scope. Both Owner endpoints also require the exact published primary site in `CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID` and `CNYOS_OWNER_EXPECTED_SITE_ORIGIN`; deploy previews, branch deploys, forged hosts and copied-site runtimes fail before authentication or database access.

Subscription ON/OFF and Drive assignment have independent server gates. `CNYOS_OWNER_CONTROL_ENABLED=true` does not enable Drive assignment; `/api/owner-drive` also requires `CNYOS_OWNER_DRIVE_ENABLED=true`. The scheduled exporter remains independently disabled until `BACKUP_ENABLED=true`.

## Direct Google Drive assignment

Migration `202609010500_owner_drive_assignment.sql` stores five folder IDs per clinic and per trust environment (`staging` or `production`). The backing tables have RLS enabled and no direct grant, including for `service_role`; reads and writes pass through service-role-only `SECURITY DEFINER` RPCs. Each change uses optimistic versioning, an idempotent request UUID, exact clinic-code confirmation, actor/reason metadata and an append-only event.

The browser sends folder URLs/IDs only. `/api/owner-drive` fixes the environment from `BACKUP_ENVIRONMENT`, authenticates the allowlisted Google Owner, resolves the encrypted service-account document from a site-scoped, strong-consistency Netlify Blob, obtains the Drive access token server-side, and verifies that the service account can add children to all five distinct folders. Every folder must be an untrashed direct child of `GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID` before the assignment can commit. The browser never receives the service-account document, Blob wrap key, `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_ENCRYPTION_KEY_BASE64` or a Google access token. Provisioning and rotation are defined in [GOOGLE_SERVICE_ACCOUNT_BLOB.md](./GOOGLE_SERVICE_ACCOUNT_BLOB.md).

The scheduled backup resolves the audited database assignment independently for each clinic. Staging and production require that database assignment; the five `GOOGLE_DRIVE_*_FOLDER_ID` environment variables are reserved for a complete `restore-test` set and are not a staging/production fallback. A missing or partial database response fails closed.

## Database enforcement

Migration `202608311800_owner_subscription_control.sql` adds the audited subscription state. Forward migration `202609010800_owner_subscription_concurrency.sql` replaces the legacy write overload with the service-role-only, version-bound RPC. A state change updates these fields in one transaction:

- `clinics.subscription_state`;
- `clinics.subscription_version`;
- actor, reason and timestamp metadata;
- append-only `clinic_subscription_control_events` evidence keyed by an idempotent request UUID.

`clinics.subscription_version` is the optimistic concurrency token returned by the list RPC. Every ON/OFF request must submit that exact value as `expectedVersion`. The database serializes the request UUID, rechecks idempotency after locking the clinic row and rejects a stale token with `CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT` before changing state. The console reloads the latest status and requires a fresh human confirmation; it never silently overwrites a newer Owner decision. The old unversioned RPC overload is removed, and update/delete on the event ledger is rejected by an append-only trigger.

The `current_clinic_id()`, `is_clinic_member()`, `current_department_role()`, `is_super_admin()`, `has_role()`, `department_can()` and `current_access_context()` functions require both an operationally active clinic and `subscription_state='active'`. Tenant RLS policies resolve data through those functions. Therefore an OFF action removes the clinic from database authorization even for a previously issued user session. It is not a CSS, route or navigation switch. `clinics.active` stays unchanged so managed backups and the encrypted logical export can continue during a commercial suspension.

The tenant bootstrap no longer sets `active=true` on conflict. If an existing clinic is suspended, the bootstrap fails with `TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED` instead of silently reactivating the subscription.

Forward migration `202609011000_owner_subscription_kill_switch_closure.sql` removes the legacy service-role key's broad direct clinical and financial writes. The remaining direct service-role DML is an exact control-plane allowlist: `profiles` insert/update; subscription-guarded `clinic_memberships` insert/update; the four global TTM import tables (`ttm_sources`, `ttm_concepts`, `ttm_concept_relations`, `ttm_diagnostic_knowledge`) insert/update; subscription-guarded `audit_logs` and `inventory_lots` insert; and subscription-guarded `patient_qr_sessions` update. Sequence access is reduced to the `audit_logs` identity sequence. A profile role edit cannot restore tenant access while the clinic is OFF because membership resolution still requires the clinic's active subscription. Bootstrap and TTM import scripts are staging-only control-plane operations with exact-project binding and a Production denylist; they are not browser capabilities.

Owner subscription, Owner Drive and backup-evidence writes remain service-role-only `SECURITY DEFINER` RPCs rather than direct table DML. Managed backup/export and restore verification may retain service-role reads while OFF. All browser tenant reads and writes fail closed; operational LINE claim/link/queue/send work also stops. The only LINE write exceptions during suspension are consent withdrawal and finalization of an exact webhook/notification already claimed before OFF, so cleanup and delivery evidence do not become stranded.

## Separate staging deployments

Netlify calls each site's primary deploy context `production`, but that label is not the clinical data environment. Both active sites below are dedicated staging deployments and must set `BACKUP_ENVIRONMENT=staging`. Variables and credentials are configured independently on each Netlify site; do not copy one customer's Supabase, Drive or encryption values to the other.

| Deployment | Netlify site | Netlify site ID | Data environment | Supabase project ref | Clinic code | Expected Drive root |
| --- | --- | --- | --- | --- | --- | --- |
| CNYOS/Chananya staging | `https://cnyos.netlify.app` | `7da5e39e-580d-44f1-8623-605313e2fb2b` | `staging` | `hsmnjwxurlmsizndjlun` | `CHANANYA-STG` | `1eQLyI8f4YBI1spmk2ArueBptkvLl1h83` |
| Jitarsa staging | `https://jitarsa-staging.netlify.app` | `a71e3b2b-0b2a-46d8-af26-e7b26739d4df` | `staging` | `qbkuyjavtvjdzfdprgqa` | `JITARSA-STG` | `1g56i9GcL7Ia3iAX3OUpqlJPBy3QF1WGm` |
| Jitarsa future-production shell | `https://jitarsa.netlify.app` | `c33db6a8-2fe8-410e-b4ff-16eeae4f33a7` | none; database-locked | none | none | none |

The future-production shell is not a substitute staging site. Keep its database unlock values, Functions credentials, Owner Drive gate and backup gate absent/false until a separate Jitarsa production Supabase project, Drive tree, service account and reviewed production release exist.

### Netlify variable matrix

Apply the following to the primary deploy of each dedicated staging site. `Build` values may contain public tenant configuration and a Supabase publishable key only. Every credential and control-plane value belongs to `Functions` scope only.

| Variable or group | Netlify scope | CNYOS staging value | Jitarsa staging value |
| --- | --- | --- | --- |
| `CLINICAL_OS_TENANT_CONFIG_JSON` | Build | CNYOS public staging tenant config | Jitarsa public staging tenant config |
| `CLINICAL_OS_STAGING_DEPLOYMENT` | Build | `true` | `true` |
| `CLINICAL_OS_REQUIRE_SOURCE_COMMIT` | Build | `true` | `true` |
| `CLINICAL_OS_SOURCE_COMMIT` | Build | exact deployed Git commit | exact deployed Git commit |
| `CLINICAL_OS_AUTH_PROVIDER` | Build | `google` | `google` |
| staging database unlock acknowledgement | Build | absent while locked; add only for reviewed authenticated staging | absent while locked; add only for reviewed authenticated staging |
| `SUPABASE_URL` | Functions | `https://hsmnjwxurlmsizndjlun.supabase.co` | `https://qbkuyjavtvjdzfdprgqa.supabase.co` |
| `CNYOS_OWNER_EXPECTED_PROJECT_REF` | Functions | `hsmnjwxurlmsizndjlun` | `qbkuyjavtvjdzfdprgqa` |
| `CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID`, `CNYOS_OWNER_EXPECTED_SITE_ORIGIN` | Functions | exact CNYOS site UUID and canonical origin | exact Jitarsa staging site UUID and canonical origin |
| `BACKUP_EXPECTED_SUPABASE_PROJECT_REF` | Functions | `hsmnjwxurlmsizndjlun` | `qbkuyjavtvjdzfdprgqa` |
| `CNYOS_OWNER_CLINIC_CODES` | Functions | `CHANANYA-STG` | `JITARSA-STG` |
| `BACKUP_ENVIRONMENT` | Functions | `staging` | `staging` |
| `BACKUP_DEPLOYMENT_ID` | Functions | staging-marked CNYOS deployment ID | `jitarsa-clinical-staging` |
| `GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID` | Functions | `1eQLyI8f4YBI1spmk2ArueBptkvLl1h83` | `1g56i9GcL7Ia3iAX3OUpqlJPBy3QF1WGm` |
| `BACKUP_PRODUCTION_SUPABASE_URL` | Functions | distinct CNYOS Production origin, denylist only | unavailable until a separate Jitarsa Production project exists |
| `CNYOS_OWNER_CONTROL_ENABLED` | Functions | enable only for the reviewed Owner ON/OFF test | enable only for the reviewed Owner ON/OFF test |
| `CNYOS_OWNER_DRIVE_ENABLED` | Functions | `false` until service account and root checks are ready | `false` until service account and root checks are ready |
| `BACKUP_ENABLED` | Functions | `false` until assignment and export test are ready | `false` until assignment and export test are ready |
| `BACKUP_INTERNAL_DISPATCH_SECRET` | Functions, secret | distinct random CNYOS staging value | distinct random Jitarsa staging value |
| `RESTORE_SOURCE_API_ENABLED` | Functions | `false` until an exact completed run and protected drill are ready | `false` while Jitarsa remains locked |
| `RESTORE_SOURCE_API_TOKEN_SHA256`, `RESTORE_SOURCE_CLINIC_CODES`, `RESTORE_SOURCE_EXPECTED_PRODUCTION_PROJECT_REF` | Functions | site-bound restore lookup values | absent while Jitarsa remains locked |
| `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64`, `BACKUP_ENCRYPTION_KEY_BASE64`, `CNYOS_OWNER_EMAILS` | Functions, secret | distinct CNYOS staging values | distinct Jitarsa staging values |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID` | Functions | immutable CNYOS credential version | immutable Jitarsa credential version |
| `GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL` | Functions | exact dedicated CNYOS service-account email | exact dedicated Jitarsa service-account email |

Never place a service-role key, service-account JSON, encryption key, OAuth client secret or Owner email allowlist in Build scope, tenant JSON, browser storage or generated files. A variable change affecting Functions requires a new deploy before testing the endpoint.

## Staging activation

Apply the ordered migration set to the isolated staging project, then configure these values on the CNYOS Netlify site with Production context and Functions-only scope:

```text
CNYOS_OWNER_CONTROL_ENABLED=true
CNYOS_OWNER_DRIVE_ENABLED=false
CNYOS_OWNER_EMAILS=<exact confirmed Google owner email>
CNYOS_OWNER_EXPECTED_PROJECT_REF=hsmnjwxurlmsizndjlun
CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID=7da5e39e-580d-44f1-8623-605313e2fb2b
CNYOS_OWNER_EXPECTED_SITE_ORIGIN=https://cnyos.netlify.app
CNYOS_OWNER_CLINIC_CODES=CHANANYA-STG
BACKUP_ENVIRONMENT=staging
BACKUP_DEPLOYMENT_ID=chananya-clinical-staging
BACKUP_EXPECTED_SUPABASE_PROJECT_REF=hsmnjwxurlmsizndjlun
BACKUP_EXPECTED_NETLIFY_SITE_ID=7da5e39e-580d-44f1-8623-605313e2fb2b
BACKUP_EXPECTED_SITE_ORIGIN=https://cnyos.netlify.app
BACKUP_PRODUCTION_SUPABASE_URL=https://qptxnrldzzinlcabudjv.supabase.co
GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID=1eQLyI8f4YBI1spmk2ArueBptkvLl1h83
GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL=<exact dedicated CNYOS service-account email>
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID=<immutable CNYOS credential version>
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64=<Functions-only secret>
BACKUP_ENABLED=false
```

Keep `CNYOS_OWNER_DRIVE_ENABLED=false` until the encrypted service-account Blob is provisioned and the service account has been shared only to this root's five direct-child folders. Keep `BACKUP_ENABLED=false` until the assignment is stored. Then enable and test one gate at a time, with a new deploy after each Functions environment change. Keep `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64` and `BACKUP_ENCRYPTION_KEY_BASE64` secret and Functions-only; all three protected values must be distinct. Staging and production reject raw `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`. The owner allowlist should also be stored as a secret because it contains personal data. `BACKUP_PRODUCTION_SUPABASE_URL` is a required origin-only denylist for staging, not a Production credential; never place a Production service-role key in a staging site.

Jitarsa staging cannot enable Owner subscription, Owner Drive, backup or restore-source lookup until it has its own distinct Jitarsa Production Supabase project to use as that denylist. Do not use the CNYOS Production origin to satisfy the Jitarsa guard.

Google OAuth must be enabled independently in each isolated Supabase project. The Google Web OAuth configuration must use the exact site/project pair:

| Deployment | Authorized JavaScript origin | Supabase OAuth callback | Application post-auth callback |
| --- | --- | --- | --- |
| CNYOS staging | `https://cnyos.netlify.app` | `https://hsmnjwxurlmsizndjlun.supabase.co/auth/v1/callback` | `https://cnyos.netlify.app/auth-callback.html` |
| Jitarsa staging | `https://jitarsa-staging.netlify.app` | `https://qbkuyjavtvjdzfdprgqa.supabase.co/auth/v1/callback` | `https://jitarsa-staging.netlify.app/auth-callback.html` |

Keep the Google OAuth client secret inside the corresponding Supabase Auth provider configuration. Do not put it in Netlify Build variables or browser configuration, and do not use `jitarsa.netlify.app` as the Jitarsa staging callback.

## Required live proof

Use synthetic staging identities only.

1. Sign in to `/owner-control.html` with the allowlisted Google owner.
2. Keep an already-authenticated synthetic staff session open.
3. Enter the exact clinic code and a reviewed reason, then set the clinic to OFF.
4. Using the existing staff session, verify `current_clinic_id()` returns null, `current_access_context()` returns no row and a tenant table query is denied/empty.
5. Verify a `clinic_subscription_control_events` row records the request ID, previous/new state, version, actor and reason without PHI.
6. Set the clinic back to ON and verify the same staff identity regains only its original clinic/department boundary.
7. Retry the same request ID and expected version; verify the result is idempotent with no second event. From a second stale snapshot, submit a different request ID with the old expected version and verify HTTP `409` / `CNYOS_OWNER_SUBSCRIPTION_VERSION_CONFLICT`, unchanged state and unchanged version.
8. Assign five isolated staging Drive folders, verify the console reports a new version, and confirm `clinic_drive_destination_events` contains one append-only event without credentials or PHI.
9. Trigger one encrypted staging export and verify every object lands only in the assigned staging folders.
10. Download that exact four-object set plus manifest into an isolated restore drill, verify hashes/source commit/counts and record successful restore evidence before calling Drive operational.

Retain non-PHI evidence against the exact source commit. Folder metadata or `canAddChildren` checks prove configuration only; a real service-account write, encrypted export and isolated restore proof are all required. A rendered console or a hidden navigation item is not sufficient evidence.

## Recovery

The console obtains the latest Supabase session before every Owner request, including after automatic token refresh. A session changing to a different account requires signing in again before an ON/OFF or Drive mutation. Auth rejection is returned as HTTP 401 with a session message, not a database failure.

If initial loading fails, the page exposes retry and local Google sign-in controls. The ON/OFF status has its own refresh control. A confirmed save followed by a failed read is shown as saved with an unconfirmed current status; a lost write response is shown as an unknown outcome. Neither case automatically resends the mutation, and another write is blocked until the current version is loaded. Local sign-out preserves the return path and leaves other devices signed in.

Use the console to return the clinic to ON. If the UI is unavailable, call the eight-argument `set_clinic_subscription_state(...)` overload with the latest `subscription_version` and the isolated project's service role through a reviewed server-side change. Do not update `subscription_state` directly: the audit, idempotency and optimistic-concurrency contracts are intentional safety controls.

For separate customer Supabase projects, deploy the same control boundary per project with a distinct service-role secret, expected project ref and clinic-code allowlist. Never aggregate customer service-role credentials into browser configuration.
