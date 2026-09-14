#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-backup}"
[[ "$mode" == backup || "$mode" == backup-and-restore ]] || {
  printf 'usage: %s [backup|backup-and-restore]\n' "$0" >&2
  exit 64
}

node_bin="${CNYOS_NODE_BIN:-/opt/cnyos-validation/node-v24.20.0-linux-x64/bin/node}"
ops="${CNYOS_BACKUP_OPS:-/srv/cnyos-staging/ops/cnyos-vps-staging.mjs}"
lock="${CNYOS_BACKUP_LOCK:-/run/lock/cnyos-staging-backup.lock}"

[[ -x "$node_bin" && -f "$ops" && ! -L "$ops" ]] || {
  printf 'CNYOS_STAGING_BACKUP_DEPENDENCY_INVALID\n' >&2
  exit 1
}

exec 9>"$lock"
flock -n 9 || {
  printf 'CNYOS_STAGING_BACKUP_ALREADY_RUNNING\n' >&2
  exit 75
}

backup_json="$($node_bin "$ops" backup)"
backup_path="$(printf '%s' "$backup_json" | "$node_bin" -e '
let raw=""; process.stdin.on("data", x => raw += x); process.stdin.on("end", () => {
  const value=JSON.parse(raw); const file=value?.metadata?.path;
  if(typeof file!=="string" || !file.startsWith("/srv/cnyos-staging/backend/backups/") || !file.endsWith(".dump")) process.exit(1);
  process.stdout.write(file);
});')" || {
  printf 'CNYOS_STAGING_BACKUP_METADATA_INVALID\n' >&2
  exit 1
}

printf 'CNYOS_STAGING_BACKUP_CREATED:%s\n' "$backup_path"

if [[ "$mode" == backup-and-restore ]]; then
  [[ "${CNYOS_RESTORE_QUIESCENCE_ACK:-}" == CNYOS_STAGING_SOURCE_QUIESCENT_READONLY ]] || {
    printf 'CNYOS_STAGING_RESTORE_REQUIRES_ENFORCED_QUIESCENCE\n' >&2
    exit 1
  }
  "$node_bin" "$ops" restore-test \
    --backup "$backup_path" \
    --operator-ack "$CNYOS_RESTORE_QUIESCENCE_ACK"
fi
