# Jitarsa and CNYOS Drive activation status — 6 September 2026

The user requested activation of CNYOS's Google Drive backup destination and recovery of Jitarsa. This report records completed changes and the remaining activation requirements. Neither Jitarsa authenticated access nor automated Drive backup is operational yet.

## Completed and verified

- CNYOS Owner Control is accessible in the user's latest screenshot. Its linked Google/GitHub authentication repair was published from commit `989374cc425ddf963e02ef79a1dcb56322f9531b`.
- Updated both Jitarsa sites to that same tested source, tree `da945534d6275167bfc1b7b1f1f0c6464f0daa25`. Main CI [33983228169](https://github.com/apisarit/chananya-clinical-wellness-os/actions/runs/33983228169) passed.
- Replaced the Jitarsa staging tenant configuration's placeholder publishable key with the enabled public key obtained from its own Supabase project. Configured the account-service clinic UUID/code for this tenant. No credential was copied from CNYOS.
- Confirmed both published deploys are current, production-context and ready, with all 10 Functions. Live manifests report the exact source commit/tree. `login.html`, `auth-login.js` and `owner-control.js` match that source byte-for-byte. Both sites retain their database lock.

| Site | Site ID | Published deploy | Published time, Asia/Bangkok |
| --- | --- | --- | --- |
| [Jitarsa staging](https://jitarsa-staging.netlify.app/login.html) | `a71e3b2b-0b2a-46d8-af26-e7b26739d4df` | `6a9c5f8e3835f594ee7c1b6a` | 6 Sep 2026 01:29:51 |
| [Jitarsa shell](https://jitarsa.netlify.app/login.html) | `c33db6a8-2fe8-410e-b4ff-16eeae4f33a7` | `6a9c5f8d8bf68da4e9114150` | 6 Sep 2026 01:29:49 |

## Jitarsa: required activation work

The existing Supabase project `qbkuyjavtvjdzfdprgqa` is ACTIVE_HEALTHY. Its clinic `7f760bc7-8a6f-4bfe-8bf3-5c349a15c070` / `JITARSA-STG` is active, subscription ON, version 1. Read-only inventory found zero Auth users, profiles and memberships. This is evidence that the project/schema exists, not a claim that historical patient data has been recovered.

1. Enable Google OAuth in this Jitarsa Supabase project using its own reviewed Google client configuration. Public Auth settings currently report `google=false`. The authorized Supabase callback is `https://qbkuyjavtvjdzfdprgqa.supabase.co/auth/v1/callback`; the application callback is `https://jitarsa-staging.netlify.app/auth-callback.html`.
2. Supply Jitarsa's own `SUPABASE_SERVICE_ROLE_KEY` as a secret in Netlify Functions scope. Configure the Owner allowlist only for the intended Owner. Do not place credentials in chat, source files or Build variables.
3. Resolve the existing customer-specific Production isolation prerequisite in [CNYOS_OWNER_CONTROL.md](./CNYOS_OWNER_CONTROL.md). The connected inventory contains Jitarsa staging but no separate Jitarsa Production project/config. Do not substitute CNYOS's Production origin or invent a placeholder to pass this check. Creating another billable project requires a concrete cost decision.
4. Reconcile migrations and provision legitimate/synthetic staging identities before activation. Supabase's migration inventory is empty although schema objects exist. Use the existing guarded recovery procedure in [AUTHENTICATED_STAGING_RUNBOOK.md](./AUTHENTICATED_STAGING_RUNBOOK.md); do not mark migrations applied from filenames alone or manufacture verified Google identities.
5. Verify tenant/role access, then apply the exact staging database acknowledgement/config and redeploy. Authenticated Google login and Owner ON/OFF still require live evidence.

## CNYOS: Drive folders located, unattended backup not connected

The existing root is [00-staging-environment](https://drive.google.com/drive/folders/1eQLyI8f4YBI1spmk2ArueBptkvLl1h83). Folder metadata confirms it is My Drive, owned by a personal Google account; no Shared Drive ID is present. Only folder metadata was read.

| Domain | Existing folder ID |
| --- | --- |
| Patients | `15lIVkMJPzwApB_5j_fzTuyryenjK9VBR` |
| Products / inventory | `1SD600SRH31rvxOZp5V0pgvAjjxrYK5yH` |
| Pharmacy | `1t4JJt7IEEwhbpApmZ3zPKa6edpgg6_Yo` |
| Transactions / audit | `1TjunPn8V-VnDQTHCAP-1uC77kgntwpBi` |
| Manifests / restore tests | `1ueEtjq5GxvWzZnnA67HLzpqaQRjiqtgm` |

The current implementation uses a service account and an encrypted, site-bound Netlify Blob. CNYOS lacks the expected service-account email, credential wrap key/ID, backup encryption key and internal dispatch secret. The inspected root and patients folder have no service-account sharing permission. No credentials or folder assignments were invented.

There is also a destination compatibility issue: Google states that service accounts cannot own files or use storage quota. They must write into a Shared Drive or use OAuth on behalf of a human user. See [Google Drive shared-drive documentation](https://developers.google.com/workspace/drive/api/guides/about-shareddrives). Therefore adding a service-account key alone does not make these existing My Drive folders usable.

To retain these folders, the application needs an Owner-authorized Google OAuth connection with protected refresh-token storage and an unattended refresh path. That adapter is not implemented by this recovery. The existing service-account path instead needs a suitable Shared Drive, its scoped service identity and the documented encrypted-credential provisioning. Either path must prove a real scoped write, encrypted export and isolated restore before enabling scheduled backup.

`CNYOS_OWNER_DRIVE_ENABLED` and `BACKUP_ENABLED` remain false. Subscription ON/OFF is configured independently; this recovery did not repeat a live subscription toggle. Google Cloud browser setup could not be reached in this run because the browser connection timed out; no Google credentials were entered or created.

## Preserved boundaries

No clinical records were read or changed, no identities/roles were altered, no subscription was toggled, no new paid project was created, and no release or database-isolation gate was bypassed. The deployment labels describe Netlify's hosting context, not clinical production readiness.
