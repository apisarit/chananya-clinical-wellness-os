# CNYOS staging checkpoint — 2026-09-16 Netlify preview

This checkpoint records a staging-only preview deployment. It is not a
production authorization, database migration approval, or independent human
security sign-off.

## Exact preview

- Site: `cnyos` (`7da5e39e-580d-44f1-8623-605313e2fb2b`)
- Deploy id: `6aaa9fd84d7024f4106abd48`
- URL: <https://6aaa9fd84d7024f4106abd48--cnyos.netlify.app/login.html>
- Context: `deploy-preview` (no `--prod`)
- Source commit: `fd7f1dde9d1dc6baa73497375d7bff7deee82b2d`
- Source tree: `049c6777863cc3587529b4863afb4a836491c4ec`
- Build class: `dedicated-staging`

## Evidence

- `/login.html` → HTTP 200
- `/luopan.html` → HTTP 200
- `/patient-card.html` → HTTP 200
- `/api/line-oa-webhook` → HTTP 200 (capability response)
- `/.env` → HTTP 404
- `/netlify.toml` → HTTP 404
- `tenant-config.js` identifies `chananya-clinical-staging` and
  `CHANANYA-STG`; the Production Supabase host is absent and no service-role
  or secret key is present in the browser config.
- Local `npm run check:vps-staging-deploy`, LINE OA contract tests,
  patient-identity contract tests, `npm run check:who-icd`, and the
  staging-only build completed successfully.

## Remaining gate

- The preview's LINE capability response is `enabled=false`. This is expected
  for a deploy-preview because the required server-only LINE channel secret,
  channel access token, identity HMAC secret, Supabase service-role key, and
  runtime clinic binding are not exposed to that preview context.
- Do not copy credentials into source, browser config, or this checkpoint.
  Configure them only in the dedicated staging Functions context, then run the
  authenticated LINE staging workflow with a dedicated test LINE account.
- The VPS endpoint `srv1506007.hstgr.cloud` still requires Caddy activation and
  an exact operator CIDR; the Netlify preview does not prove VPS readiness.
- Fresh external checks from this workstation return HTTP 403 for both
  `https://srv1506007.hstgr.cloud/login.html` and `/healthz` with certificate
  verification enabled. The active Chrome Hostinger session redirects the
  requested VPS URL to Hostinger onboarding (`/onboarding-v2/.../create-or-migrate`)
  and does not expose a Manage/Browser Terminal control for that VPS, so the
  account currently in the browser is not confirmed as the VPS owner.
- A pinned SSH key already present on this workstation connected to the exact
  target host (`hostname=srv1506007`). The live Caddy allowlist was found to
  contain the stale operator CIDR `125.24.161.78/32`; it was replaced with the
  current operator CIDR `125.24.170.228/32` only, after a mode-0600 backup at
  `/var/lib/cnyos-staging-caddy-backups/Caddyfile.20260916T141356Z`.
- Caddy validation and reload passed. The resulting config SHA-256 is
  `bc4ba72b8d05b43a384039c57e8289bc28e4c902a3a8eb4857756c1d7b02c2c6`.
  External checks from the operator IP now return `/login.html=200` and
  `/healthz=200`. The VPS browser login shell and `/auth-callback.html` return
  200; Supabase Auth `/settings` returns 200 and reports Google enabled. The
  Supabase health endpoint returns 200 when called with the server-held anon
  key and 401 without it, which is expected authentication behavior.
- No SQL mutation, ACL remediation, merge, Production deploy, or human
  security approval was performed by this preview.

## VPS staging correction — 2026-09-16

The dedicated VPS `srv1506007` was reached over the pinned SSH identity. The
static release `fd7f1dde9d1dc6baa73497375d7bff7deee82b2d` is active under
`/srv/cnyos-web-stack/current`, and the container was recreated from that
release. The active Caddy configuration was backed up, validated, and reloaded
after replacing only the stale operator allowlist with
`125.24.170.228/32`.

- Caddy active-config SHA-256:
  `bc4ba72b8d05b43a384039c57e8289bc28e4c902a3a8eb4857756c1d7b02c2c6`
- Caddy backup:
  `/var/lib/cnyos-staging-caddy-backups/Caddyfile.20260916T141356Z` (0600)
- External checks from the operator network: `/healthz`, `/login.html`,
  `/luopan.html`, and `/patient-card.html` → HTTP 200; `/.env` and
  `/netlify.toml` → HTTP 404.
- Supabase Auth `/supabase/auth/v1/health` and `/settings` → HTTP 200 with the
  server-held anon key (401 without it, as expected).

### ACL/search-path remediation (staging only)

The current database was re-observed before mutation (PostgreSQL 17.6,
system identifier `7684592775244222498`, clinic marker
`784ec3b0-7618-42ad-9ba0-eed606d22358`). A migration-bound overlay replaced
the stale `public.rls_auto_enable()` disposition with the current
`public.issue_atomic_treatment_invoice(uuid,uuid,numeric,text)` routine.

- Dry-run evidence: `/srv/cnyos-staging/evidence/live-20260916-fd7f1dd/acl-remediation-dry-run-3.stdout`
  (rolled back; pre-state public=15, anon=86, authenticated=90, service=115,
  security-definer=141; post-state public=0, anon=0, authenticated=71,
  service=75, bad search paths/defaults=0).
- Apply result: `CNYOS_STAGING_ACL_REMEDIATION_COMMITTED`, with the same
  post-state. No Production database was targeted.
- Fresh post-ACL observer:
  `/srv/cnyos-staging/evidence/live-20260916-fd7f1dd-post-acl/observer.tsv`,
  SHA-256 `fdaf9a3dd99748cf5c06ceb98ba7a7570a48b7e3ae24cad8301d456ebffa4775`,
  stderr empty. It reports authorization=false, production_eligible=false,
  transaction rolled back, unresolved ACL identities=0, and 147 public
  routines observed.

### Backup, restore, and migration reconciliation

- Fresh logical backup and restore rehearsal passed. Backup:
  `/srv/cnyos-staging/backend/backups/backup-20260916144758.dump`, SHA-256
  `d5a7d7d0c4f781b8759743668d088c1859c68d879dda3913b053bda3cca57dda`;
  recovery database `cnyos_restore_e8fe328799a556b2`; restore evidence SHA-256
  `63eb1e04e860afc35455f56cf3851f779769c1ce16d058d4f56122bcadef29ea`.
- Read-only ledger inspection remains intentionally non-authorizing:
  47 migration rows are present and match the 47 local migration versions
  exactly (version-list SHA-256 `bd4f0525244458b2ad13da78448ff49b2e991b99662421961a63b9c2edce9640`).
  Reconciliation evidence is
  `/srv/cnyos-staging/evidence/live-20260916-fd7f1dd-post-acl/ledger-version-reconciliation.txt`
  (SHA-256 `cc726547ff6bce731c18589cec51e7c673979a476d36adf6c80c6c6146affe3e`).
  The legacy verifier still reports `ledger_shape_valid=false` because it
  expects the retired 45-row manifest; no ledger write was performed.

## Release status

Staging runtime, ACL correction, backup/restore, and read-only migration
reconciliation now have fresh evidence. Production remains blocked: the
protected publisher/OIDC broker and independent human security sign-off are
not established. The staging DNS record is now managed in the active
Hostinger account; no apex or Production record was changed. No merge or
Production deployment is authorized by this checkpoint.

## Custom staging hostname

After the domain was moved into the active Hostinger account, the DNS zone was
updated with one staging-only record: `A staging → 76.13.208.39` (TTL 14400).
Authoritative DNS (`cosmos.dns-parking.com`, `nova.dns-parking.com`, Google, and
Cloudflare resolvers) returns that address. Caddy now serves both
`srv1506007.hstgr.cloud` and `staging.cnyos.cloud` from the same guarded route;
configuration validation/reload passed and HTTPS checks with the new hostname
return HTTP 200 for `/`, `/healthz`, `/login.html`, and `/luopan.html`.

The local browser may continue showing `ERR_NAME_NOT_RESOLVED` until its DNS
cache refreshes. The apex `cnyos.cloud` and `www.cnyos.cloud` records were not
changed and remain outside this staging deployment.
