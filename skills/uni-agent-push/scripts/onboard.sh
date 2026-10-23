#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${UNI_PUSH_BIN:-}" ]; then
  binary=$UNI_PUSH_BIN
elif command -v uni-push >/dev/null 2>&1; then
  binary=$(command -v uni-push)
elif [ -x "${UNI_PUSH_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/uni-push" ]; then
  binary="${UNI_PUSH_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/uni-push"
else
  sh "$script_dir/install.sh"
  binary="${UNI_PUSH_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}/uni-push"
fi
exec "$binary" onboard "$@"
