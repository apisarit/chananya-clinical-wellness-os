import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const mode = relative => fs.statSync(path.join(root, relative)).mode & 0o777;

test('runtime image is immutable static content and drops privileges', () => {
  const dockerfile = read('deploy/vps-staging/Dockerfile');
  assert.match(dockerfile, /^FROM nginx:1\.29\.3-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^COPY --chown=101:101 dist\/ /m);
  assert.match(dockerfile, /^USER 101:101$/m);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /npm (?:install|start)|COPY \. /);
});

test('compose exposes only the static web on host loopback', () => {
  const compose = read('deploy/vps-staging/docker-compose.yml');
  assert.match(compose, /^  web:$/m);
  assert.doesNotMatch(compose, /^  caddy:$/m);
  assert.doesNotMatch(compose, /^  (?:db|postgres):$/m);
  assert.match(compose, /"127\.0\.0\.1:18080:80"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /external: true/);
  assert.match(compose, /name: webapp-network/);
  assert.doesNotMatch(compose, /"(?:80|443):(?:80|443)"/);
});

test('native Caddy template preserves Supabase loopback and proxies the web loopback', () => {
  const caddy = read('deploy/vps-staging/Caddyfile');
  assert.match(caddy, /^__CNYOS_STAGING_DOMAIN__ \{$/m);
  assert.match(caddy, /not remote_ip __CNYOS_STAGING_ALLOWED_CIDR__/);
  assert.match(caddy, /respond @adminAuth 403/);
  assert.match(caddy, /respond @api 503/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:18080/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:18000/g);
  assert.doesNotMatch(caddy, /host\.docker\.internal|reverse_proxy web:/);
});

test('Caddy permits only exact hashes for current inline authentication styles', () => {
  const caddy = read('deploy/vps-staging/Caddyfile');
  for (const file of ['login.html', 'auth.html', 'login-v3.html', 'auth-callback.html']) {
    const html = read(file);
    const match = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(match, `${file} inline style must remain hash-bound`);
    const digest = crypto.createHash('sha256').update(match[1]).digest('base64');
    assert.match(caddy, new RegExp(`'sha256-${digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.doesNotMatch(caddy, /style-src[^;]*'unsafe-inline'/);
});

test('application workflow prepares evidence without touching a privileged runner', () => {
  const workflow = read('.github/workflows/deploy-vps-staging.yml');
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^      - codex\/vps-staging-candidate-20260915$/m);
  assert.match(workflow, /refs\/heads\/codex\/vps-staging-candidate-20260915/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /runs-on:.*self-hosted/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CNYOS_STAGING_DOMAIN: srv1506007\.hstgr\.cloud/);
  assert.match(workflow, /staging_config=config\/tenant\.cnyos-staging\.json/);
  assert.doesNotMatch(workflow, /CNYOS_STAGING_TENANT_CONFIG_B64|secrets\./);
  assert.match(workflow, /kind: 'cnyos_vps_staging_candidate'/);
  assert.match(workflow, /authorization: false/);
  assert.match(workflow, /productionEligible: false/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /deploy\/vps-staging\/scripts\/deploy\.sh|docker compose up/);
  assert.doesNotMatch(workflow, /production deploy|deploy.*production/i);
});

test('deployment verifies exact source and rolls back failed health checks', () => {
  const deploy = read('deploy/vps-staging/scripts/deploy.sh');
  assert.match(deploy, /SOURCE_COMMIT_MISMATCH/);
  assert.match(deploy, /SOURCE_WORKTREE_DIRTY/);
  assert.match(deploy, /pull --ignore-buildable/);
  assert.match(deploy, /up -d --build --remove-orphans --wait --wait-timeout 120/);
  assert.match(deploy, /up -d --no-build --remove-orphans --wait --wait-timeout 120/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:18080\/healthz/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:18000\/auth\/v1\/health/);
  assert.match(deploy, /supabase\/auth\/v1\/health/);
  assert.match(deploy, /--resolve "\$CNYOS_STAGING_DOMAIN:443:127\.0\.0\.1"/);
  assert.match(deploy, /I_ACKNOWLEDGE_INITIAL_NATIVE_CADDY_ROUTE_IS_PENDING/);
  assert.match(deploy, /PUBLIC_HEALTH_FAILED/);
  assert.doesNotMatch(deploy, /docker system prune|rm -rf|--volumes/);
});

test('backup is logical, locked and supports isolated restore rehearsal', () => {
  const backup = read('deploy/vps-staging/scripts/backup-and-restore-check.sh');
  assert.match(backup, /cnyos-vps-staging\.mjs/);
  assert.match(backup, /flock -n/);
  assert.match(backup, / backup\)/);
  assert.match(backup, /restore-test/);
  assert.match(backup, /CNYOS_STAGING_SOURCE_QUIESCENT_READONLY/);
  assert.match(backup, /CNYOS_STAGING_RESTORE_REQUIRES_ENFORCED_QUIESCENCE/);
  assert.doesNotMatch(backup, /\btar\b|docker volume|\/var\/lib\/docker/);
});

test('operator scripts are executable and UFW refuses unsafe SSH assumptions', () => {
  for (const file of [
    'deploy/vps-staging/scripts/deploy.sh',
    'deploy/vps-staging/scripts/backup-and-restore-check.sh',
    'deploy/vps-staging/scripts/activate-native-caddy-route.sh',
    'deploy/vps-staging/scripts/configure-ufw.sh',
    'deploy/vps-staging/scripts/install-github-runner.sh'
  ]) assert.equal(mode(file), 0o755, `${file} must be executable`);
  const ufw = read('deploy/vps-staging/scripts/configure-ufw.sh');
  assert.match(ufw, /I_HAVE_A_SECOND_SSH_SESSION_AND_CONSOLE_ACCESS/);
  assert.match(ufw, /EXPECTED_SSH_PORT_22_NOT_CONFIRMED/);
  assert.match(ufw, /ufw limit 22\/tcp/);
  assert.match(ufw, /ufw allow 80\/tcp/);
  assert.match(ufw, /ufw allow 443\/tcp/);
});

test('native Caddy activation backs up and restores configuration on failed readiness', () => {
  const activation = read('deploy/vps-staging/scripts/activate-native-caddy-route.sh');
  assert.match(activation, /I_HAVE_VERIFIED_THE_LOOPBACK_WEB_AND_CADDY_BACKUP/);
  assert.match(activation, /install -m 0600 "\$current" "\$backup"/);
  assert.match(activation, /caddy validate --config "\$next"/);
  assert.match(activation, /systemctl reload caddy/);
  assert.match(activation, /http:\/\/127\.0\.0\.1:18000\/auth\/v1\/health/);
  assert.match(activation, /supabase\/auth\/v1\/health/);
  assert.match(activation, /install -m 0644 "\$backup" "\$current"/);
  assert.doesNotMatch(activation, /systemctl stop caddy|tls_insecure_skip_verify|curl[^\n]*\s-k(?:\s|$)/);
});

test('runner installer rejects public repositories and verifies its archive', () => {
  const runner = read('deploy/vps-staging/scripts/install-github-runner.sh');
  assert.match(runner, /\[\[ "\$visibility" == private \]\]/);
  assert.match(runner, /apisarit\/cnyos-staging-deployment-control/);
  assert.match(runner, /CNYOS_SELF_HOSTED_RUNNER_REQUIRES_PRIVATE_REPOSITORY/);
  assert.match(runner, /GITHUB_CONTROLLER_READ_TOKEN/);
  assert.match(runner, /Authorization: Bearer \$GITHUB_CONTROLLER_READ_TOKEN/);
  assert.match(runner, /env -u GITHUB_CONTROLLER_READ_TOKEN/);
  assert.match(runner, /sha256sum --check --status/);
  assert.match(runner, /--labels cnyos-staging-deployer/);
  assert.match(runner, /svc\.sh" install/);
  assert.doesNotMatch(runner, /usermod|groupadd|docker group/);
  assert.doesNotMatch(runner, /echo .*REGISTRATION_TOKEN|printf .*REGISTRATION_TOKEN/);
});
