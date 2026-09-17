#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'CNYOS_NATIVE_CADDY_ACTIVATION_FAILED:%s\n' "$1" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail ROOT_REQUIRED
[[ "${CNYOS_NATIVE_CADDY_ACTIVATION_ACK:-}" == I_HAVE_VERIFIED_THE_LOOPBACK_WEB_AND_CADDY_BACKUP ]] || fail ACTIVATION_ACK_REQUIRED
: "${CNYOS_STAGING_DOMAIN:?CNYOS_STAGING_DOMAIN is required}"
: "${CNYOS_STAGING_ALLOWED_CIDR:?CNYOS_STAGING_ALLOWED_CIDR is required}"

node_bin="${CNYOS_NODE_BIN:-/opt/cnyos-validation/node-v24.20.0-linux-x64/bin/node}"
release_root=/srv/cnyos-web-stack
template="$release_root/current/Caddyfile"
current=/etc/caddy/Caddyfile
backup_root=/var/lib/cnyos-staging-caddy-backups
[[ -x "$node_bin" && -f "$template" && ! -L "$template" ]] || fail TEMPLATE_INVALID
[[ -f "$current" && ! -L "$current" ]] || fail CURRENT_CADDYFILE_INVALID
systemctl is-active --quiet caddy || fail CADDY_SERVICE_NOT_ACTIVE
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18080/healthz >/dev/null || fail LOOPBACK_WEB_NOT_HEALTHY
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18000/auth/v1/health >/dev/null || fail SUPABASE_AUTH_NOT_HEALTHY

install -d -m 0700 "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$backup_root/Caddyfile.$stamp"
install -m 0600 "$current" "$backup"
next="/etc/caddy/Caddyfile.cnyos-next-$stamp"

"$node_bin" - "$template" "$next" "$CNYOS_STAGING_DOMAIN" "$CNYOS_STAGING_ALLOWED_CIDR" <<'NODE' || fail TEMPLATE_RENDER_FAILED
const fs = require('node:fs');
const net = require('node:net');
const [template, output, domain, cidr] = process.argv.slice(2);
const labels = domain.split('.');
if (domain.length > 253 || labels.length < 2 || labels.some(label =>
  !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) process.exit(1);
const parts = cidr.split('/');
const family = net.isIP(parts[0]);
const prefix = Number(parts[1]);
if (parts.length !== 2 || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) process.exit(1);
const source = fs.readFileSync(template, 'utf8');
if ((source.match(/__CNYOS_STAGING_DOMAIN__/g) || []).length !== 1 ||
    (source.match(/__CNYOS_STAGING_ALLOWED_CIDR__/g) || []).length !== 1) process.exit(1);
const rendered = source.replace('__CNYOS_STAGING_DOMAIN__', domain).replace('__CNYOS_STAGING_ALLOWED_CIDR__', cidr);
fs.writeFileSync(output, rendered, { flag: 'wx', mode: 0o600 });
NODE

caddy validate --config "$next" --adapter caddyfile || fail CADDY_VALIDATION_FAILED
install -m 0644 "$next" "$current"
if ! systemctl reload caddy || \
   ! curl --fail --silent --show-error --max-time 30 "https://$CNYOS_STAGING_DOMAIN/healthz" >/dev/null || \
   ! curl --fail --silent --show-error --max-time 30 \
     --resolve "$CNYOS_STAGING_DOMAIN:443:127.0.0.1" \
     "https://$CNYOS_STAGING_DOMAIN/supabase/auth/v1/health" >/dev/null; then
  install -m 0644 "$backup" "$current"
  systemctl reload caddy || true
  fail PUBLIC_HEALTH_FAILED_CONFIG_RESTORED
fi
printf 'CNYOS_NATIVE_CADDY_ROUTE_ACTIVATED:%s\n' "$(sha256sum "$current" | cut -d' ' -f1)"
