# Encrypted Google service-account credential Blob

Staging and production do not place `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` in Netlify environment variables. The document is encrypted locally and stored in the site-scoped `cnyos-functions-secrets` Netlify Blob store with strong-consistency reads. Only a 32-byte wrapping key and its immutable key ID remain as Functions-only environment variables.

The AES-256-GCM envelope authenticates the exact Netlify site ID and canonical site origin, Supabase project ref, operator-defined logical deployment ID, data environment, expected service-account client email, wrap-key ID and creation timestamp. `BACKUP_DEPLOYMENT_ID` is a stable logical identity for this site/environment, not Netlify's per-deploy ID; rotate it only as an intentional credential-binding change. A credential copied to another site, tenant, Google identity, deployment identity, environment or key ID fails before Google access. The resolver also rejects oversized or malformed envelopes, unknown service-account fields, non-RSA private keys, mismatched Google project/email values and non-Google token or certificate endpoints.

`GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64`, `BACKUP_ENCRYPTION_KEY_BASE64` and `BACKUP_INTERNAL_DISPATCH_SECRET` must be three distinct values. The Blob wrap key protects the credential envelope; it is not the database-backup encryption key.

## One-time provisioning

Keep Owner Drive and backup disabled throughout this procedure. Use a dedicated service-account JSON file outside the repository, make it readable only by its owner, and never pass JSON or keys as command-line arguments.

```bash
chmod 600 /absolute/protected/path/google-service-account.json
openssl rand -base64 32
```

Configure the following values in the administrator's local shell or protected runner. Do not commit them. `NETLIFY_AUTH_TOKEN` is used only by the provisioning process and must be unset afterward.

```text
NETLIFY_AUTH_TOKEN=<authorized Netlify token>
NETLIFY_SITE_ID=<exact site UUID>
BACKUP_EXPECTED_NETLIFY_SITE_ID=<same exact site UUID>
BACKUP_EXPECTED_SITE_ORIGIN=https://<exact-site>.netlify.app
BACKUP_EXPECTED_SUPABASE_PROJECT_REF=<exact 20-character project ref>
BACKUP_DEPLOYMENT_ID=<exact deployment identity>
BACKUP_ENVIRONMENT=staging|production
GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL=<exact dedicated service-account client_email>
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID=<new immutable rotation ID>
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64=<new 32-byte base64 key>
```

Validate locally without writing:

```bash
npm run credential:drive:provision -- --dry-run /absolute/protected/path/google-service-account.json
```

Create the site-scoped Blob once:

```bash
npm run credential:drive:provision -- /absolute/protected/path/google-service-account.json
```

The write is create-only. Reusing a key ID fails instead of overwriting the active credential. A successful message means the encrypted object was written and decrypted after a strong read; it does not prove Google OAuth token issuance, folder permissions, or a backup export.

Set only these credential references in the matching Netlify site's Production deploy context with Functions scope:

```text
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_ID=<matching immutable ID>
GOOGLE_DRIVE_SERVICE_ACCOUNT_WRAP_KEY_BASE64=<matching 32-byte key>
GOOGLE_DRIVE_EXPECTED_SERVICE_ACCOUNT_EMAIL=<same exact client_email authenticated at provisioning>
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=<absent>
GOOGLE_DRIVE_SERVICE_ACCOUNT_ALLOW_RESTORE_TEST_DIRECT_JSON=false
```

After redeploying, confirm exact site binding, then obtain separate live evidence that the service account can mint a token and write only to all five intended direct-child folders. Keep `CNYOS_OWNER_DRIVE_ENABLED=false` and `BACKUP_ENABLED=false` until that evidence is reviewed.

## Rotation and rollback

1. Generate a new wrap key and a never-before-used key ID.
2. Provision a new version-specific Blob. The existing Blob remains unchanged.
3. Update the two Functions-only wrap variables together and redeploy.
4. Verify Owner Drive folder checks, one encrypted export and the isolated restore evidence.
5. If verification fails, restore the prior key ID and wrap key and redeploy; the prior Blob remains available.
6. Delete an old version only after the retention and rollback window has ended and the new restore drill is accepted.

Do not overwrite a Blob version in place. Do not reuse an AES-GCM key ID for different credential material. After rotation, remeasure the Functions environment size; moving this document out of environment variables does not reduce unrelated variables.

## Restore-test exception

Only an isolated `BACKUP_ENVIRONMENT=restore-test` runtime may use direct JSON, and it must explicitly set `GOOGLE_DRIVE_SERVICE_ACCOUNT_ALLOW_RESTORE_TEST_DIRECT_JSON=true`. Staging and production fail closed if either the flag or `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` is present.
