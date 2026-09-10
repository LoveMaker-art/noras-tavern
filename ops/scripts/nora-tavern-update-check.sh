#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PY="${TAVERN_UPDATE_PYTHON:-python3}"
exec "$PY" -B "$SCRIPT_DIR/nora-tavern-update-check.py" "$@"
