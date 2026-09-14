# CNYOS VPS staging Docker deployment

This package prepares the static CNYOS staging site as an immutable NGINX image
behind the VPS's existing native Caddy service. It does not start a second Caddy or
include PostgreSQL: the existing PostgreSQL 17 / Supabase staging stack remains a
separate `cnyos-vps-staging` Compose project. Production is not a target.

## Required GitHub controls

1. Never attach the privileged runner to the public application repository.
   Register it only against the private `apisarit/cnyos-staging-deployment-control`
   repository. The installer verifies that repository is private.
2. In the application repository, create the GitHub environment `staging` and
   require approval before access to its candidate-build configuration.
3. Add environment variable `CNYOS_STAGING_DOMAIN` and environment secret
   `CNYOS_STAGING_TENANT_CONFIG_B64`. The latter is the base64 encoding of the
   dedicated VPS staging tenant JSON. It must contain only the browser publishable
   key, never a service-role key or database password.
4. Label only the private-controller runner `cnyos-staging-deployer`. Do not assign that
   label to a development machine or to the n8n/OpenClaw VPS.

The application workflow is serialized, accepts only exact `main` commits, does
not persist a GitHub credential, runs the complete contract suite, and retains a
source-bound candidate packet with `authorization: false`. It never schedules work
on the privileged runner and never deploys. The private controller must verify and
authorize the exact packet before calling the server-side deployer.

## One-time VPS preparation

Run these commands from a second SSH session while Hostinger console access remains
available. The firewall script refuses to proceed unless the current SSH server
port is 22 and the explicit lockout acknowledgement is supplied.

Use GitHub's **Settings → Actions → Runners → New self-hosted runner** page to get
the current runner version, Linux x64 SHA-256 and temporary registration token.
Also create a short-lived fine-grained token with read-only metadata access to the
private controller repository. Read both tokens without echo so they do not enter
shell history; revoke the read token immediately after installation.

```bash
read -rsp 'Controller read token: ' GITHUB_CONTROLLER_READ_TOKEN; echo
read -rsp 'Runner registration token: ' GITHUB_RUNNER_REGISTRATION_TOKEN; echo
export GITHUB_CONTROLLER_READ_TOKEN GITHUB_RUNNER_REGISTRATION_TOKEN
sudo --preserve-env=GITHUB_CONTROLLER_READ_TOKEN,GITHUB_RUNNER_REGISTRATION_TOKEN env \
  RUNNER_VERSION='REPLACE_FROM_GITHUB' \
  RUNNER_SHA256='REPLACE_FROM_GITHUB' \
  ./deploy/vps-staging/scripts/install-github-runner.sh
unset GITHUB_CONTROLLER_READ_TOKEN GITHUB_RUNNER_REGISTRATION_TOKEN
```

The runner account must not join the Docker group; that group is root-equivalent.
It submits a short-lived OIDC request to the root-owned publisher broker, which
alone may call the pinned deployer. Prepare the deployment directory/network for
that broker service account, not for the runner:

```bash
sudo install -d -o root -g root -m 0750 \
  /srv/cnyos-web-stack /srv/cnyos-web-stack/releases
sudo docker network inspect webapp-network >/dev/null 2>&1 || \
  sudo docker network create webapp-network
sudo env CNYOS_UFW_LOCKOUT_ACK=I_HAVE_A_SECOND_SSH_SESSION_AND_CONSOLE_ACCESS \
  ./deploy/vps-staging/scripts/configure-ufw.sh
```

## Existing Caddy integration

The web container publishes only `127.0.0.1:18080`; it does not own ports 80/443.
The existing native Caddy keeps certificate custody and continues proxying Supabase
through `127.0.0.1:18000`. The reviewed template changes only the final static-web
route to `127.0.0.1:18080` while retaining the IP allowlist and API denials.

For the first release only, stage the healthy loopback web, then run the guarded
native-Caddy activation. It writes a private backup, renders exact domain/CIDR
values, validates before replacement, reloads without stopping Caddy, checks public
HTTPS, and restores the old config on failure:

```bash
sudo env \
  CNYOS_NATIVE_CADDY_ACTIVATION_ACK=I_HAVE_VERIFIED_THE_LOOPBACK_WEB_AND_CADDY_BACKUP \
  CNYOS_STAGING_DOMAIN=srv1506007.hstgr.cloud \
  CNYOS_STAGING_ALLOWED_CIDR='REPLACE_WITH_CURRENT_OPERATOR_CIDR' \
  ./deploy/vps-staging/scripts/activate-native-caddy-route.sh
```

Caddy obtains and renews the public certificate only while DNS points to the VPS
and inbound ports 80/443 reach the native service.

## Logical backup and restore verification

Install the wrapper and systemd units after the already-tested
`/srv/cnyos-staging/ops/cnyos-vps-staging.mjs` helper is present:

```bash
sudo install -m 0750 deploy/vps-staging/scripts/backup-and-restore-check.sh \
  /usr/local/sbin/cnyos-staging-backup
sudo install -m 0644 deploy/vps-staging/systemd/cnyos-staging-backup.service \
  deploy/vps-staging/systemd/cnyos-staging-backup.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cnyos-staging-backup.timer
sudo systemctl list-timers cnyos-staging-backup.timer
```

The daily job writes a custom-format, mode-0600 `pg_dump`; it never allocates a TTY
and never archives a live Docker volume. A `pg_restore --list` check alone is not
accepted as recovery proof. After writes are technically quiesced/read-only, run
the isolated rehearsal explicitly; the script will not invent that acknowledgement:

```bash
sudo env CNYOS_RESTORE_QUIESCENCE_ACK=CNYOS_STAGING_SOURCE_QUIESCENT_READONLY \
  /usr/local/sbin/cnyos-staging-backup backup-and-restore
```

The rehearsal restores a new isolated database, compares reviewed public/auth
fingerprints, and verifies that the primary remained unchanged. Restore databases
and evidence are intentionally retained for review.

If cron is mandatory, use this instead of the two timers (not in addition):

```cron
0 2 * * * root /usr/local/sbin/cnyos-staging-backup backup >>/var/log/cnyos-staging-backup.log 2>&1
```
