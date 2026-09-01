#!/bin/sh
set -eu
echo '[tavern-updater] 开始更新。' >&2
if [ -n "${TAVERN_PYTHON:-}" ]; then
  PY="$TAVERN_PYTHON"
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
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tavern-bootstrap.XXXXXX")
trap 'rm -f "$WORK/bootstrap-manifest.json" "$WORK/tavern-updater-bootstrap.py"; rmdir "$WORK" 2>/dev/null || true' EXIT HUP INT TERM
curl -fsSL --connect-timeout 15 --max-time 120 "$BASE/bootstrap-manifest.json" -o "$WORK/bootstrap-manifest.json"
curl -fsSL --connect-timeout 15 --max-time 120 "$BASE/tavern-updater-bootstrap.py" -o "$WORK/tavern-updater-bootstrap.py"
"$PY" -B - "$WORK" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'bootstrap-manifest.json').read_text())
actual = hashlib.sha256((root / 'tavern-updater-bootstrap.py').read_bytes()).hexdigest()
if manifest.get('scope') != 'tavern-updater-bootstrap' or actual != manifest.get('sha256'):
    raise SystemExit('Bootstrap checksum mismatch')
PY
exec "$PY" -u -B "$WORK/tavern-updater-bootstrap.py" "$@"
