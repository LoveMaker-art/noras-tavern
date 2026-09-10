#!/bin/sh
set -eu
echo '[nora-tavern-install] 开始首次安装。' >&2

arg_value() {
  wanted=$1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      "$wanted")
        [ "$#" -gt 1 ] && printf '%s\n' "$2"
        return 0
        ;;
      "$wanted="*)
        printf '%s\n' "${1#*=}"
        return 0
        ;;
    esac
    shift
  done
  return 1
}

REQUESTED_NORA_HOME=$(arg_value "--nora-home" "$@" || true)
REQUESTED_HERMES_HOME=$(arg_value "--hermes-home" "$@" || arg_value "--data-root" "$@" || true)
REQUESTED_INSTALL_ROOT=$(arg_value "--install-root" "$@" || true)

if [ -n "$REQUESTED_NORA_HOME" ]; then
  NORA_TAVERN_HOME="$REQUESTED_NORA_HOME"
elif [ -z "${NORA_TAVERN_HOME:-}" ]; then
  case "$(uname -s)" in
    Darwin) NORA_TAVERN_HOME="$HOME/Library/NoraTavern" ;;
    *) NORA_TAVERN_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/nora-tavern" ;;
  esac
fi
HERMES_HOME="${REQUESTED_HERMES_HOME:-${HERMES_HOME:-$NORA_TAVERN_HOME/hermes}}"
HERMES_INSTALL_DIR="${HERMES_INSTALL_DIR:-$HERMES_HOME/hermes-agent}"
TAVERN_DATA_ROOT="${REQUESTED_INSTALL_ROOT:-${TAVERN_DATA_ROOT:-$NORA_TAVERN_HOME/tavern}}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$NORA_TAVERN_HOME/cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$NORA_TAVERN_HOME/data}"
export NORA_TAVERN_HOME HERMES_HOME HERMES_INSTALL_DIR TAVERN_DATA_ROOT XDG_CACHE_HOME XDG_DATA_HOME

if [ -n "${TAVERN_PYTHON:-}" ]; then
  PY="$TAVERN_PYTHON"
elif [ -x "$HERMES_INSTALL_DIR/venv/bin/python3" ]; then
  PY="$HERMES_INSTALL_DIR/venv/bin/python3"
elif [ -x "$HERMES_INSTALL_DIR/venv/bin/python" ]; then
  PY="$HERMES_INSTALL_DIR/venv/bin/python"
elif [ -x /opt/hermes/.venv/bin/python3 ]; then
  PY=/opt/hermes/.venv/bin/python3
elif [ -x /opt/hermes/.venv/bin/python ]; then
  PY=/opt/hermes/.venv/bin/python
else
  PY=$(command -v python3 || command -v python)
fi
"$PY" -B -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null
BASE=https://github.com/LoveMaker-art/noras-tavern/releases/latest/download
TAG=$("$PY" -B - "$@" <<'PY'
import argparse
p = argparse.ArgumentParser(add_help=False)
p.add_argument('--tag')
a, _ = p.parse_known_args()
print(a.tag or '')
PY
)
[ -z "$TAG" ] || BASE="https://github.com/LoveMaker-art/noras-tavern/releases/download/$TAG"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/nora-tavern-install.XXXXXX")
trap 'rm -f "$WORK/first-install-manifest.json" "$WORK/nora-tavern-first-install-bootstrap.py"; rmdir "$WORK" 2>/dev/null || true' EXIT HUP INT TERM
curl -fsSL --connect-timeout 15 --max-time 120 "$BASE/first-install-manifest.json" -o "$WORK/first-install-manifest.json"
curl -fsSL --connect-timeout 15 --max-time 120 "$BASE/nora-tavern-first-install-bootstrap.py" -o "$WORK/nora-tavern-first-install-bootstrap.py"
"$PY" -B - "$WORK" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'first-install-manifest.json').read_text())
actual = hashlib.sha256((root / 'nora-tavern-first-install-bootstrap.py').read_bytes()).hexdigest()
if manifest.get('scope') != 'nora-tavern-first-install-bootstrap' or actual != manifest.get('sha256'):
    raise SystemExit('First installer bootstrap checksum mismatch')
PY
exec "$PY" -u -B "$WORK/nora-tavern-first-install-bootstrap.py" \
  --nora-home "$NORA_TAVERN_HOME" \
  --hermes-home "$HERMES_HOME" \
  --install-root "$TAVERN_DATA_ROOT" \
  "$@"
