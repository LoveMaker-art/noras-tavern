#!/bin/sh
# Build from a bounded, isolated source snapshot; never archive a live app tree.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/package-release.mjs" "$@"
