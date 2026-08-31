#!/bin/sh
set -eu
TAVERN_BOOTSTRAP_DOWNLOAD=https://github.com/LoveMaker-art/noras-tavern/releases/latest/download
# Select the Bootstrap from the same explicit release as its payload. Otherwise
# a prerelease request still downloads the old stable updater before seeing --tag.
TAVERN_BOOTSTRAP_TAG=$(python3 - "$@" <<'PY'
import argparse, re
parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
parser.add_argument('--tag', action='append')
args, _ = parser.parse_known_args()
if args.tag and (len(args.tag) != 1 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}', args.tag[0])):
    raise SystemExit('Use one valid release tag.')
print(args.tag[0] if args.tag else '')
PY
)
if [ -n "$TAVERN_BOOTSTRAP_TAG" ]; then
    TAVERN_BOOTSTRAP_DOWNLOAD="https://github.com/LoveMaker-art/noras-tavern/releases/download/$TAVERN_BOOTSTRAP_TAG"
fi
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
