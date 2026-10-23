#!/bin/sh
set -u

config=
output="uni-push-issue-$(date -u +%Y%m%dT%H%M%SZ).md"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 20 ;;
  esac
done

if [ -n "${UNI_PUSH_BIN:-}" ]; then
  binary=$UNI_PUSH_BIN
elif command -v uni-push >/dev/null 2>&1; then
  binary=$(command -v uni-push)
else
  binary="${UNI_PUSH_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/uni-push"
fi
test -x "$binary" || { echo "uni-push is not installed" >&2; exit 21; }

run() {
  if [ -n "$config" ]; then "$binary" "$1" --config "$config" --json 2>/dev/null
  else "$binary" "$1" --json 2>/dev/null
  fi
}
version=$($binary --version 2>/dev/null || true)
doctor=$(run doctor || true)
targets=$(run targets || true)
channels=$(run channels || true)
umask 077
{
  printf '# Uni Push issue report\n\n'
  printf -- '- Generated: `%s`\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf -- '- OS: `%s`\n' "$(uname -s)"
  printf -- '- Architecture: `%s`\n\n' "$(uname -m)"
  for pair in "Version|$version" "Doctor|$doctor" "Targets|$targets" "Channels|$channels"; do
    title=${pair%%|*}; value=${pair#*|}
    printf '## %s\n\n```json\n%s\n```\n\n' "$title" "$value"
  done
  printf '> Review target and channel aliases before sharing. No issue was submitted automatically.\n'
} > "$output"
chmod 600 "$output"
printf '%s\n' "$output"
