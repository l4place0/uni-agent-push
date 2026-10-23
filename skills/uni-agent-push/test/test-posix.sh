#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/uni-agent-push-skill-test.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
mkdir -p "$temporary/release" "$temporary/mock-bin" "$temporary/install"

# GNU/Linux runners ship sha256sum; macOS ships shasum.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "{\"schema_version\":1,\"command\":\"version\",\"status\":\"ok\",\"version\":\"0.1.0\"}"' > "$temporary/release/uni-push"
chmod 755 "$temporary/release/uni-push"
tar -C "$temporary/release" -czf "$temporary/release/uni-push-darwin-x64.tar.gz" uni-push
checksum=$(sha256 "$temporary/release/uni-push-darwin-x64.tar.gz")
printf '%s  %s\n' "$checksum" "uni-push-darwin-x64.tar.gz" > "$temporary/release/SHA256SUMS"

printf '%s\n' '#!/bin/sh' 'if [ "$1" = "-s" ]; then printf Darwin; else printf x86_64; fi' > "$temporary/mock-bin/uname"
# Exercise routing and checksum logic through a URL-rewriting curl double.
printf '%s\n' '#!/bin/sh' 'output=' 'while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then output=$2; shift 2; else url=$1; shift; fi; done' 'name=${url##*/}' 'cp "$MOCK_RELEASE_DIR/$name" "$output"' > "$temporary/mock-bin/curl"
chmod 755 "$temporary/mock-bin/uname" "$temporary/mock-bin/curl"
test_path="$temporary/mock-bin:/usr/bin:/bin:/usr/sbin:/sbin"
PATH="$test_path" MOCK_RELEASE_DIR="$temporary/release" UNI_PUSH_INSTALL_DIR="$temporary/install" sh "$root/scripts/install.sh" >/dev/null
test -x "$temporary/install/uni-push"
"$temporary/install/uni-push" --version | grep -q '"version":"0.1.0"'

# GitHub Skill downloads may lose executable bits. Exercise both wrappers from
# a 0644 copy and require their nested install invocation to keep working.
mkdir -p "$temporary/installed-scripts" "$temporary/update-install" "$temporary/onboard-install"
cp "$root/scripts/install.sh" "$root/scripts/update.sh" "$root/scripts/onboard.sh" "$temporary/installed-scripts/"
chmod 644 "$temporary/installed-scripts/"*.sh
PATH="$test_path" MOCK_RELEASE_DIR="$temporary/release" UNI_PUSH_INSTALL_DIR="$temporary/update-install" sh "$temporary/installed-scripts/update.sh" >/dev/null
test -x "$temporary/update-install/uni-push"
PATH="$test_path" MOCK_RELEASE_DIR="$temporary/release" UNI_PUSH_INSTALL_DIR="$temporary/onboard-install" sh "$temporary/installed-scripts/onboard.sh" >/dev/null
test -x "$temporary/onboard-install/uni-push"

printf '%s\n' 'bad  uni-push-darwin-x64.tar.gz' > "$temporary/release/SHA256SUMS"
if PATH="$test_path" MOCK_RELEASE_DIR="$temporary/release" UNI_PUSH_INSTALL_DIR="$temporary/install" sh "$root/scripts/install.sh" >/dev/null 2>&1; then
  echo "checksum mismatch was accepted" >&2
  exit 1
fi
"$temporary/install/uni-push" --version | grep -q '"version":"0.1.0"'

printf '%s\n' '#!/bin/sh' 'case "$1" in --version) echo "{\"version\":\"0.1.0\"}";; doctor) echo "{\"status\":\"passed\"}";; targets) echo "{\"targets\":[{\"name\":\"owner\"}]}";; channels) echo "{\"channels\":[{\"name\":\"serverchan.owner\"}]}";; esac' > "$temporary/fake-uni-push"
chmod 755 "$temporary/fake-uni-push"
report="$temporary/issue.md"
UNI_PUSH_BIN="$temporary/fake-uni-push" sh "$root/scripts/issue.sh" --output "$report" >/dev/null
grep -q 'No issue was submitted automatically' "$report"
case $(uname -s) in
  Darwin) mode=$(stat -f %Lp "$report") ;;
  *) mode=$(stat -c %a "$report") ;;
esac
test "$mode" = 600
if grep -Eqi 'send[_-]?key|appsecret|bot token|chat[_-]?id|openid|credential' "$report"; then
  echo "issue report contains forbidden secret or provider-ID fields" >&2
  exit 1
fi
# Documentation lives in SKILL.md and, when this skill is embedded in the CLI
# repository, in the repository README two levels up. Neither may depend on
# POSIX executable bits.
for document in "$root/SKILL.md" "$root/../../README.md"; do
  if [ -f "$document" ] && grep -Eq '^\./scripts/[^ ]+\.sh' "$document"; then
    echo "documentation depends on POSIX executable bits: $document" >&2
    exit 1
  fi
done
printf '%s\n' "POSIX thin-script tests passed"
