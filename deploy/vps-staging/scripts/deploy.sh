#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'CNYOS_VPS_STAGING_DEPLOY_FAILED:%s\n' "$1" >&2
  exit 1
}

release_sha="${1:-}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail RELEASE_SHA_INVALID

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || fail SOURCE_REPOSITORY_MISSING
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$release_sha" ]] || fail SOURCE_COMMIT_MISMATCH
git -C "$repo_root" diff-index --quiet HEAD -- || fail SOURCE_WORKTREE_DIRTY
[[ "$(git -C "$repo_root" config --get remote.origin.url)" == "https://github.com/apisarit/chananya-clinical-wellness-os.git" ]] || fail SOURCE_ORIGIN_MISMATCH

: "${CNYOS_STAGING_DOMAIN:?CNYOS_STAGING_DOMAIN is required}"
node - "$CNYOS_STAGING_DOMAIN" <<'NODE' || fail STAGING_DOMAIN_INVALID
const [domain] = process.argv.slice(2);
const labels = domain.split('.');
if (domain.length > 253 || labels.length < 2 || labels.some(label =>
  !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) process.exit(1);
NODE

command -v docker >/dev/null || fail DOCKER_MISSING
docker compose version >/dev/null || fail DOCKER_COMPOSE_MISSING
docker network inspect webapp-network >/dev/null 2>&1 || fail WEBAPP_NETWORK_MISSING
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:18000/auth/v1/health >/dev/null || fail SUPABASE_AUTH_NOT_HEALTHY

manifest="$repo_root/dist/deploy-manifest.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || fail STAGING_ARTIFACT_MISSING
source_tree="$(git -C "$repo_root" rev-parse 'HEAD^{tree}')"
node - "$manifest" "$release_sha" "$source_tree" <<'NODE' || fail STAGING_ARTIFACT_IDENTITY_INVALID
const fs = require('node:fs');
const [file, commit, tree] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value?.source?.commit !== commit || value?.source?.tree !== tree ||
    value?.source?.verified !== true ||
    value?.build?.deploymentClass !== 'dedicated-staging' ||
    value?.safety?.databaseLocked !== false ||
    value?.safety?.stagingDatabaseExplicitlyAcknowledged !== true) process.exit(1);
NODE

release_root="${CNYOS_RELEASE_ROOT:-/srv/cnyos-web-stack}"
[[ "$release_root" == /srv/cnyos-web-stack ]] || fail RELEASE_ROOT_INVALID
release_dir="$release_root/releases/$release_sha"
[[ ! -e "$release_dir" ]] || fail RELEASE_ALREADY_EXISTS

install -d -m 0750 "$release_root/releases"
install -d -m 0755 "$release_dir/dist"
cp -a "$repo_root/dist/." "$release_dir/dist/"
install -m 0644 "$repo_root/deploy/vps-staging/Dockerfile" "$release_dir/Dockerfile"
install -m 0644 "$repo_root/deploy/vps-staging/nginx.conf" "$release_dir/nginx.conf"
install -m 0644 "$repo_root/deploy/vps-staging/Caddyfile" "$release_dir/Caddyfile"
install -m 0644 "$repo_root/deploy/vps-staging/docker-compose.yml" "$release_dir/docker-compose.yml"

umask 077
{
  printf 'CNYOS_RELEASE_SHA=%s\n' "$release_sha"
} > "$release_dir/.env"

previous=""
if [[ -L "$release_root/current" ]]; then
  previous="$(readlink -f "$release_root/current")"
  [[ "$previous" == "$release_root"/releases/* && -f "$previous/docker-compose.yml" ]] || fail CURRENT_RELEASE_INVALID
fi

compose=(docker compose --project-name cnyos-web-staging --env-file "$release_dir/.env" --file "$release_dir/docker-compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" pull --ignore-buildable
"${compose[@]}" build --pull web

rollback() {
  local code="$1"
  set +e
  if [[ -n "$previous" ]]; then
    docker compose --project-name cnyos-web-staging --env-file "$previous/.env" --file "$previous/docker-compose.yml" \
      up -d --no-build --remove-orphans --wait --wait-timeout 120
  else
    "${compose[@]}" down
  fi
  printf 'CNYOS_VPS_STAGING_ROLLED_BACK:%s\n' "$code" >&2
  exit 1
}

"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 120 || rollback COMPOSE_HEALTH_FAILED
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18080/healthz >/dev/null || rollback LOOPBACK_HEALTH_FAILED

public_status=deployed
if ! curl --fail --silent --show-error --max-time 30 \
  --resolve "$CNYOS_STAGING_DOMAIN:443:127.0.0.1" \
  "https://$CNYOS_STAGING_DOMAIN/healthz" >/dev/null || \
   ! curl --fail --silent --show-error --max-time 30 \
  --resolve "$CNYOS_STAGING_DOMAIN:443:127.0.0.1" \
  "https://$CNYOS_STAGING_DOMAIN/supabase/auth/v1/health" >/dev/null; then
  if [[ "${CNYOS_INITIAL_CADDY_ROUTE_ACK:-}" != I_ACKNOWLEDGE_INITIAL_NATIVE_CADDY_ROUTE_IS_PENDING ]]; then
    rollback PUBLIC_HEALTH_FAILED
  fi
  public_status=staged_pending_native_caddy_route
fi

link_tmp="$release_root/.current-$release_sha"
ln -s "$release_dir" "$link_tmp"
mv -Tf "$link_tmp" "$release_root/current"
printf 'CNYOS_VPS_STAGING_%s:%s\n' "$public_status" "$release_sha"
