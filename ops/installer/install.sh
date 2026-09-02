#!/bin/sh
set -eu
echo '[nora-tavern-install] 开始首次安装。' >&2
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
exec "$PY" -u -B "$WORK/nora-tavern-first-install-bootstrap.py" "$@"
