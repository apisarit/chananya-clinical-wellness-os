#!/usr/bin/env bash
set -Eeuo pipefail

# Local-only, read-only Qwen helper. Model output is never evaluated or applied.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
model="${OLLAMA_MODEL:-qwen-local-assistant:latest}"
max_file_bytes="${OLLAMA_MAX_FILE_BYTES:-120000}"
prompt=''
declare -a files=()

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/ollama-qwen-review.sh --prompt 'review this' [--file path ...]
  scripts/ollama-qwen-review.sh --prompt-file prompt.txt [--file path ...]
  printf '%s' 'review this' | scripts/ollama-qwen-review.sh [--file path ...]

Options:
  --model NAME       Local Ollama model (default: qwen-local-assistant:latest)
  --prompt TEXT      Review prompt
  --prompt-file PATH Read the prompt from a local file
  --file PATH        Include a repository-relative source file (repeatable)
EOF
}

die() {
  printf 'ollama-qwen-review: %s\n' "$1" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --model)
      (($# >= 2)) || die '--model requires a value'
      model="$2"
      shift 2
      ;;
    --prompt)
      (($# >= 2)) || die '--prompt requires a value'
      prompt="$2"
      shift 2
      ;;
    --prompt-file)
      (($# >= 2)) || die '--prompt-file requires a path'
      [[ -f "$2" ]] || die "prompt file not found: $2"
      prompt="$(< "$2")"
      shift 2
      ;;
    --file)
      (($# >= 2)) || die '--file requires a path'
      files+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

if [[ -z "$prompt" && ! -t 0 ]]; then
  prompt="$(cat)"
fi
[[ -n "$prompt" ]] || die 'provide --prompt, --prompt-file, or stdin'
command -v ollama >/dev/null 2>&1 || die 'ollama CLI is not installed'
[[ "$model" =~ ^[A-Za-z0-9._:-]+$ ]] || die 'model name contains unsupported characters'
[[ "$max_file_bytes" =~ ^[0-9]+$ ]] || die 'OLLAMA_MAX_FILE_BYTES must be an integer'

if ! ollama show "$model" >/dev/null 2>&1; then
  die "local model is not installed: $model"
fi

request=$'You are a local, read-only code-review assistant for CNYOS.\n'
request+=$'Analyze only the supplied prompt and source. Do not access networks, credentials, patient data, or production.\n'
request+=$'Do not emit commands intended for automatic execution. Return findings, risks, and a proposed patch as plain text; a human or CI must review and apply it.\n\n'
request+="Task:\n${prompt}\n"

for file in "${files[@]}"; do
  [[ -f "$file" ]] || die "source file not found: $file"
  resolved="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  case "$resolved" in
    "$repo_root"/*) ;;
    *) die "source file must be inside the repository: $file" ;;
  esac
  case "$(basename "$resolved")" in
    .env|.env.*|*.pem|*.key|*secret*|*credential*|*service-account*)
      die "refusing a credential-like file: $file"
      ;;
  esac
  bytes="$(wc -c < "$resolved" | tr -d '[:space:]')"
  ((bytes <= max_file_bytes)) || die "source file exceeds ${max_file_bytes} bytes: $file"
  request+=$'\n\n--- SOURCE: '
  request+="${resolved#"$repo_root/"}"
  request+=$' ---\n'
  request+="$(< "$resolved")"
done

# Keep the invocation local. Never pipe model output to a shell, git, SQL
# client, or deployment command.
OLLAMA_NO_CLOUD=1 ollama run "$model" <<<"$request"
