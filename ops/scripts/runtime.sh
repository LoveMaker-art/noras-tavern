#!/bin/sh
set -eu

if [ -z "${HERMES_HOME:-}" ]; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ] && [ -d /opt/data/skills ]; then
    HERMES_HOME=/opt/data
  else
    HERMES_HOME="$HOME/.hermes"
  fi
fi
DATA_ROOT="${TAVERN_DATA_ROOT:-$HERMES_HOME}"
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
