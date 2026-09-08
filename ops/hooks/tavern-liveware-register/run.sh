#!/bin/sh
# Recover saved identities; first registration belongs to the launcher.
set -eu
if [ -z "${HERMES_HOME:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  HERMES_HOME=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
fi
export HERMES_HOME
exec "$HERMES_HOME/hermes-agent/venv/bin/python3" -B "$HERMES_HOME/scripts/nora-instance.py" recover-existing
