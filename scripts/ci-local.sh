#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPOSITORY_ROOT"

if [ "${1:-}" = "--install" ]; then
  corepack pnpm install --no-frozen-lockfile
fi

corepack pnpm ci:local
