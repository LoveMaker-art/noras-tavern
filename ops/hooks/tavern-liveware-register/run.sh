#!/bin/sh
# Gateway startup may recover existing Apps, never run initial provisioning.
set -eu
if [ -z "${HERMES_HOME:-}" ]; then
  if [ "$(uname -s)" = Linux ] && [ -d /opt/data/skills ]; then HERMES_HOME=/opt/data; else HERMES_HOME="$HOME/.hermes"; fi
fi
DATA_ROOT="${TAVERN_DATA_ROOT:-$HERMES_HOME}"
PY="${TAVERN_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /opt/hermes/.venv/bin/python ]; then PY=/opt/hermes/.venv/bin/python; else PY="$(command -v python3)"; fi
fi
LOCK_RUNNER="$DATA_ROOT/apps/tavern-ops/updater/runtime_lock.py"
if [ "${1:-}" != --under-maintenance-lock ]; then
  exec "$PY" -B "$LOCK_RUNNER" --home "$DATA_ROOT" -- sh "$0" --under-maintenance-lock
fi
"$PY" -B "$LOCK_RUNNER" --home "$DATA_ROOT" --check-inherited
exec "$PY" -B "$DATA_ROOT/apps/tavern-ops/updater/liveware_integration.py" --home "$DATA_ROOT" recover-existing
