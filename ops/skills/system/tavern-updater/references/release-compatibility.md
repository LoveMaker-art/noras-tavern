# Full-release contract

The trusted repository is `LoveMaker-art/noras-tavern`. An explicit GitHub Release
tag must have `release-manifest.json`, `SHA256SUMS` and all three archives. A branch
push does not create these assets. SHA-256 binds review to selected bytes; it is
not a publisher signature.

| Archive | Target below HERMES_HOME |
| --- | --- |
| nora-tavern-app.tar.gz | apps/tavern-runtime, including Story Profile |
| nora-tavern-nora-mcp.tar.gz | apps/nora-mcp |
| nora-tavern-ops.tar.gz | apps/tavern-ops; installs managed skills and AGENTS block |

Supported existing layout: `apps/tavern-runtime/native-runtime.json` schema 2,
state in `tavern-state`, engine config in `tavern-state/native-runtime/config.yaml`,
loopback port 8799. Custom paths and old Python data are rejected before apply;
do not force them through by changing environment variables.

## First adoption

Obtain the approved repository commit through the normal trusted source channel.
Use Hermes' Python interpreter (includes PyYAML) to run `ops/updater/update.py`
from that reviewed checkout, outside active skill directories. Use the same
fetch/review/apply process below. This installs the skill entrypoint and versioned
ops implementation together. Old updater recovery records remain untouched.
The old Python archive format is never treated as compatible.

## Commands

Global `--hermes-home /exact/home` goes before the operation. The source and skill
entrypoints accept the same arguments:

```sh
python scripts/update.py --hermes-home /opt/data fetch --tag <approved-tag> --destination <new-private-directory>
python scripts/update.py --hermes-home /opt/data review --release-dir <directory> --manifest-sha256 <sha256>
python scripts/update.py --hermes-home /opt/data apply --transaction <review-path> --expected-plan <digest> --confirm
python scripts/update.py --hermes-home /opt/data rollback --transaction <review-path> --expected-plan <digest> --confirm
```

Review checks archives, per-file hashes, traversal, symlinks, duplicate members,
size limits, the full inventory and current target hashes. Apply checks again.
Only previously managed obsolete files are pruned; unknown user files remain.
First adoption lists every overwrite but cannot infer whether a same-name source
file is a user hotfix: inspect unexpected changes before approving.

## Recovery and activation

Plans, backups and receipts live under `tavern-updates-v2/review-*`, outside skill
discovery. `receipt.json` records file intents so interrupted operations can use
the matching rollback command. Recovery includes configuration; keep it private
and retain the latest usable backup until acceptance.

The updater restarts Tavern through its Node lifecycle and probes a fresh
read-only MCP process. It does not restart the Hermes process executing the
update. `installed-awaiting-hermes-reload` requires owner `/reload-mcp` and a fresh
session for skills/AGENTS. These are distinct activation checks. Liveware bindings,
cookies, account settings and user data are not release assets and stay in place.
