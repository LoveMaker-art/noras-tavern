#!/bin/sh
set -eu
TAVERN_BOOTSTRAP_DOWNLOAD=https://github.com/LoveMaker-art/noras-tavern/releases/latest/download
TAVERN_BOOTSTRAP_WORK=$(mktemp -d "${TMPDIR:-/tmp}/tavern-bootstrap.XXXXXX")
cleanup() {
    # Exactly the directory created above; no installation data is here.
    rm -f "$TAVERN_BOOTSTRAP_WORK/bootstrap-manifest.json" "$TAVERN_BOOTSTRAP_WORK/tavern-updater-bootstrap.py"
    rmdir "$TAVERN_BOOTSTRAP_WORK"
}
trap cleanup EXIT HUP INT TERM
curl -fsSL "$TAVERN_BOOTSTRAP_DOWNLOAD/bootstrap-manifest.json" -o "$TAVERN_BOOTSTRAP_WORK/bootstrap-manifest.json"
curl -fsSL "$TAVERN_BOOTSTRAP_DOWNLOAD/tavern-updater-bootstrap.py" -o "$TAVERN_BOOTSTRAP_WORK/tavern-updater-bootstrap.py"
python3 - "$TAVERN_BOOTSTRAP_WORK" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'bootstrap-manifest.json').read_text())
if manifest.get('scope') != 'tavern-updater-bootstrap' or hashlib.sha256((root / 'tavern-updater-bootstrap.py').read_bytes()).hexdigest() != manifest.get('sha256'):
    raise SystemExit('Bootstrap checksum mismatch')
PY
python3 "$TAVERN_BOOTSTRAP_WORK/tavern-updater-bootstrap.py" "$@"
