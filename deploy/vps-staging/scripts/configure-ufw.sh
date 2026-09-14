#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || {
  printf 'CNYOS_UFW_ROOT_REQUIRED\n' >&2
  exit 1
}
[[ "${CNYOS_UFW_LOCKOUT_ACK:-}" == I_HAVE_A_SECOND_SSH_SESSION_AND_CONSOLE_ACCESS ]] || {
  printf 'CNYOS_UFW_LOCKOUT_ACK_REQUIRED\n' >&2
  exit 1
}

read -r _ _ _ ssh_port <<< "${SSH_CONNECTION:-}"
[[ "$ssh_port" == 22 ]] || {
  printf 'CNYOS_UFW_EXPECTED_SSH_PORT_22_NOT_CONFIRMED\n' >&2
  exit 1
}

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'SSH rate-limited'
ufw allow 80/tcp comment 'Caddy HTTP ACME redirect'
ufw allow 443/tcp comment 'Caddy HTTPS'
ufw allow 443/udp comment 'Caddy HTTP3'
ufw --force enable
ufw status verbose
