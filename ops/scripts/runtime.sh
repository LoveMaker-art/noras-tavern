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
if [ "$command" = restart ]; then
  shift
  run_id=production
  expect_run_id=0
  for arg do
    if [ "$expect_run_id" -eq 1 ]; then
      run_id=$arg
      expect_run_id=0
      break
    fi
    if [ "$arg" = --run-id ]; then
      expect_run_id=1
    fi
  done
  if [ "$expect_run_id" -eq 1 ]; then
    echo "--run-id requires a value" >&2
    exit 2
  fi
  "$PYTHON" "$LIFECYCLE" stop --run-id "$run_id"
  exec "$PYTHON" "$LIFECYCLE" start "$@"
fi

case "$command" in
  install|prepare|start|stop|status|sync)
    exec "$PYTHON" "$LIFECYCLE" "$@"
    ;;
  *)
    echo "usage: runtime.sh {install|prepare|start|stop|restart|status|sync}" >&2
    exit 2
    ;;
esac
