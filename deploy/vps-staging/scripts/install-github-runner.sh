#!/usr/bin/env bash
set -Eeuo pipefail

repo="apisarit/cnyos-staging-deployment-control"
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { printf 'GITHUB_RUNNER_ROOT_REQUIRED\n' >&2; exit 1; }
: "${GITHUB_RUNNER_REGISTRATION_TOKEN:?temporary GitHub runner registration token is required}"
: "${GITHUB_CONTROLLER_READ_TOKEN:?temporary read-only token for the private controller repository is required}"
: "${RUNNER_VERSION:?RUNNER_VERSION is required}"
: "${RUNNER_SHA256:?RUNNER_SHA256 is required}"
[[ "$RUNNER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'RUNNER_VERSION_INVALID\n' >&2; exit 1; }
[[ "$RUNNER_SHA256" =~ ^[0-9a-f]{64}$ ]] || { printf 'RUNNER_SHA256_INVALID\n' >&2; exit 1; }

visibility="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  --header "Authorization: Bearer $GITHUB_CONTROLLER_READ_TOKEN" \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/$repo" | sed -n 's/.*"visibility":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
[[ "$visibility" == private ]] || {
  printf 'CNYOS_SELF_HOSTED_RUNNER_REQUIRES_PRIVATE_REPOSITORY\n' >&2
  exit 1
}

runner_user="cnyos-runner"
runner_root="/opt/actions-runner-cnyos"
id "$runner_user" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$runner_user"
install -d -o "$runner_user" -g "$runner_user" -m 0750 "$runner_root"

archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$RUNNER_SHA256" "$archive" | sha256sum --check --status || {
  printf 'GITHUB_RUNNER_ARCHIVE_DIGEST_MISMATCH\n' >&2
  exit 1
}
tar --extract --gzip --file "$archive" --directory "$runner_root" --no-same-owner
chown -R "$runner_user:$runner_user" "$runner_root"

env -u GITHUB_CONTROLLER_READ_TOKEN sudo -u "$runner_user" "$runner_root/config.sh" \
  --url "https://github.com/$repo" \
  --token "$GITHUB_RUNNER_REGISTRATION_TOKEN" \
  --name "$(hostname)-cnyos-staging" \
  --labels cnyos-staging-deployer \
  --work _work \
  --unattended \
  --replace

"$runner_root/svc.sh" install "$runner_user"
"$runner_root/svc.sh" start
"$runner_root/svc.sh" status
