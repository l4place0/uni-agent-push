#!/bin/sh
set -eu

repository=${UNI_PUSH_REPOSITORY:-l4place0/uni-agent-push}
version=${UNI_PUSH_VERSION:-latest}
install_dir=${UNI_PUSH_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version=$2; shift 2 ;;
    --install-dir) install_dir=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 20 ;;
  esac
done

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported operating system" >&2; exit 21 ;;
esac
case $(uname -m) in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) echo "Unsupported CPU architecture" >&2; exit 21 ;;
esac

archive="uni-push-${os}-${architecture}.tar.gz"
if [ "$version" = latest ]; then
  base="https://github.com/${repository}/releases/latest/download"
else
  case "$version" in v*) tag=$version ;; *) tag="v$version" ;; esac
  base="https://github.com/${repository}/releases/download/${tag}"
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/uni-push-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --fail --location --silent --show-error "$base/$archive" --output "$temporary/$archive"
curl --fail --location --silent --show-error "$base/SHA256SUMS" --output "$temporary/SHA256SUMS"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$temporary/SHA256SUMS")
test -n "$expected" || { echo "Release checksum is missing" >&2; exit 22; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')
fi
test "$expected" = "$actual" || { echo "Release checksum mismatch" >&2; exit 22; }
tar -xzf "$temporary/$archive" -C "$temporary"
mkdir -p -m 700 "$install_dir"
cp "$temporary/uni-push" "$install_dir/.uni-push.new"
chmod 755 "$install_dir/.uni-push.new"
mv "$install_dir/.uni-push.new" "$install_dir/uni-push"
"$install_dir/uni-push" --version
printf 'Installed %s\n' "$install_dir/uni-push"
