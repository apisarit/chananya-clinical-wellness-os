# CNYOS Owner Subscription Safety Console

Status: source implementation present; staging activation and live ON/OFF evidence are required before the commercial gate may pass.

The Owner Console is a CNYOS control-plane route at `/owner-control.html`. It does not grant a customer administrator control over subscription state. Access requires all of the following:

- a valid Supabase user session created through Google;
- a confirmed email address in the server-only `CNYOS_OWNER_EMAILS` allowlist;
- the exact Supabase project ref in `CNYOS_OWNER_EXPECTED_PROJECT_REF`;
- the exact clinic code in `CNYOS_OWNER_CLINIC_CODES`;
- `CNYOS_OWNER_CONTROL_ENABLED=true` in the Netlify Functions runtime.

The browser receives only the normal Supabase publishable key and its user session. `SUPABASE_SERVICE_ROLE_KEY` stays in the Netlify Function and must have Functions-only scope.

## Database enforcement

Migration `202608311800_owner_subscription_control.sql` adds the audited subscription state and a service-role-only RPC. A state change updates these fields in one transaction:

- `clinics.subscription_state`;
- `clinics.subscription_version`;
- actor, reason and timestamp metadata;
- append-only `clinic_subscription_control_events` evidence keyed by an idempotent request UUID.

The `current_clinic_id()`, `is_clinic_member()`, `current_department_role()`, `is_super_admin()`, `has_role()`, `department_can()` and `current_access_context()` functions require both an operationally active clinic and `subscription_state='active'`. Tenant RLS policies resolve data through those functions. Therefore an OFF action removes the clinic from database authorization even for a previously issued user session. It is not a CSS, route or navigation switch. `clinics.active` stays unchanged so managed backups and the encrypted logical export can continue during a commercial suspension.

The tenant bootstrap no longer sets `active=true` on conflict. If an existing clinic is suspended, the bootstrap fails with `TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED` instead of silently reactivating the subscription.

## Staging activation

Apply the ordered migration set to the isolated staging project, then configure these values on the CNYOS Netlify site with Production context and Functions-only scope:

```text
CNYOS_OWNER_CONTROL_ENABLED=true
CNYOS_OWNER_EMAILS=<exact confirmed Google owner email>
CNYOS_OWNER_EXPECTED_PROJECT_REF=hsmnjwxurlmsizndjlun
CNYOS_OWNER_CLINIC_CODES=CHANANYA-STG
```

Keep `SUPABASE_SERVICE_ROLE_KEY` secret and Functions-only. The owner allowlist should also be stored as a secret because it contains personal data. Do not configure any Production project ref or customer Production service-role key in the CNYOS staging site.

Google OAuth must be enabled in the isolated Supabase project. The Google Web OAuth client must register:

```text
Authorized JavaScript origin: https://cnyos.netlify.app
Supabase OAuth callback: https://hsmnjwxurlmsizndjlun.supabase.co/auth/v1/callback
Application post-auth callback: https://cnyos.netlify.app/auth-callback.html
```

## Required live proof

Use synthetic staging identities only.

1. Sign in to `/owner-control.html` with the allowlisted Google owner.
2. Keep an already-authenticated synthetic staff session open.
3. Enter the exact clinic code and a reviewed reason, then set the clinic to OFF.
4. Using the existing staff session, verify `current_clinic_id()` returns null, `current_access_context()` returns no row and a tenant table query is denied/empty.
5. Verify a `clinic_subscription_control_events` row records the request ID, previous/new state, version, actor and reason without PHI.
6. Set the clinic back to ON and verify the same staff identity regains only its original clinic/department boundary.
7. Retry the same request ID and verify the result is idempotent with no second state transition.

Retain non-PHI evidence against the exact source commit. A rendered console or a hidden navigation item is not sufficient evidence.

## Recovery

Use the console to return the clinic to ON. If the UI is unavailable, call `set_clinic_subscription_state(...)` with the isolated project's service role through a reviewed server-side change. Do not update `subscription_state` directly: the audit and idempotency contract is an intentional safety control.

For separate customer Supabase projects, deploy the same control boundary per project with a distinct service-role secret, expected project ref and clinic-code allowlist. Never aggregate customer service-role credentials into browser configuration.
