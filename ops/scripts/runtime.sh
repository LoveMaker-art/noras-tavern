#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
if [ -z "${HERMES_HOME:-}" ]; then
  NORA_ROOT=$(CDPATH= cd -- "$INSTALL_ROOT/.." && pwd)
  HERMES_HOME="$NORA_ROOT/hermes"
fi
DATA_ROOT="${TAVERN_DATA_ROOT:-$INSTALL_ROOT}"
APP_DIR="${TAVERN_APP_DIR:-$DATA_ROOT/apps/tavern-runtime}"
PYTHON="${TAVERN_PYTHON:-$(command -v python3)}"
LIFECYCLE="$APP_DIR/native_lifecycle.py"

if [ ! -f "$LIFECYCLE" ]; then
  echo "Nora Tavern lifecycle not found: $LIFECYCLE" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- status
fi
command=$1
case "$command" in
  install|prepare|start|stop|restart|status|sync)
    exec "$PYTHON" "$LIFECYCLE" "$@"
    ;;
  *)
    echo "usage: runtime.sh {install|prepare|start|stop|restart|status|sync}" >&2
    exit 2
    ;;
esac
