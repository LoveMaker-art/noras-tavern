#!/bin/sh
# Existing installation recovery: no App creation, model sync, or gateway restart.
set -eu
if [ -z "${HERMES_HOME:-}" ]; then
  if [ "$(uname -s)" = Linux ] && [ -d /opt/data/skills ]; then HERMES_HOME=/opt/data; else HERMES_HOME="$HOME/.hermes"; fi
fi
PY="${TAVERN_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /opt/hermes/.venv/bin/python ]; then PY=/opt/hermes/.venv/bin/python; else PY="$(command -v python3)"; fi
fi
exec "$PY" -B "${TAVERN_DATA_ROOT:-$HERMES_HOME}/apps/tavern-ops/updater/liveware_integration.py" --home "${TAVERN_DATA_ROOT:-$HERMES_HOME}" recover-existing
