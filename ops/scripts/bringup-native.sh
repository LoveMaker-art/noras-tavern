#!/bin/sh
# Existing installation recovery: no App creation, model sync, or gateway restart.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
if [ -z "${HERMES_HOME:-}" ]; then
  NORA_ROOT=$(CDPATH= cd -- "$INSTALL_ROOT/.." && pwd)
  HERMES_HOME="$NORA_ROOT/hermes"
fi
TAVERN_DATA_ROOT="${TAVERN_DATA_ROOT:-$INSTALL_ROOT}"
PY="${TAVERN_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /opt/hermes/.venv/bin/python ]; then PY=/opt/hermes/.venv/bin/python; else PY="$(command -v python3)"; fi
fi
exec "$PY" -B "$TAVERN_DATA_ROOT/apps/tavern-ops/updater/liveware_integration.py" --home "$TAVERN_DATA_ROOT" --hermes-home "$HERMES_HOME" recover-existing
