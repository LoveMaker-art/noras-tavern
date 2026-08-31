# Full-release contract

The default CLI uses whole-directory transactions. An explicit apply approval
includes the reviewed maintenance interruption, Python data conversion and code
replacement. [Isolated rehearsals](isolated-rehearsal.md) exercise the same code;
they do not establish target-host UI or gateway acceptance.

The trusted repository is `LoveMaker-art/noras-tavern`. An explicit GitHub Release
tag must have `release-manifest.json`, `SHA256SUMS` and all three archives. A branch
push does not create these assets. SHA-256 binds review to selected bytes; it is
not a publisher signature.

| Archive | Target below HERMES_HOME |
| --- | --- |
| nora-tavern-app.tar.gz | apps/tavern-runtime, including Story Profile |
| nora-tavern-nora-mcp.tar.gz | apps/nora-mcp |
| nora-tavern-ops.tar.gz | apps/tavern-ops; installs managed skills and AGENTS block |

Supported source: Python `apps/tavern-runtime/backend/server.py`, or current Node
`native-runtime.json` schema 2; state in `tavern-state`, loopback port 8799. Python
runtime_cast schema 3/Profile schema 1 are converted and validated on a copy.
Node requires its existing `native-runtime/config.yaml`; World v1 conversion is
outside scope. Custom paths, unsafe filesystem entries and mixed Node/Python
ownership require review. Individual incompatible Python records do not block
installation: compatible records import and the rest stay archived with reasons.
Old `/assets/` images are read from the reviewed Python frontend before switching.

## Data outcome

Program installation and Python data import have separate results. After a full
state snapshot, import each card/book and each complete World independently.
Missing or incompatible dependencies defer the World; no partial runtime card,
chat, manifest or lore binding becomes active. An unusable ledger stays archived
while its valid raw chat imports without compression. Ordinary auxiliary files
are retained, never parsed as active records.

`dataImport` reports imported counts, deferred count, backup and report paths.
The report lists each `archiveFile` relative to `tavern-state`. Original namespace
bytes remain under `python-source`; unsupported Profile files are retained under
`python-source-profile`. Valid Profile files and original model configuration
are preserved. Only the target machine supplies model credentials.
The transaction's `backup/state` is the complete pre-update data tree.
`partial` is a successful installation with pending conversion, not data loss
or a reason to run rollback. Archived Python chat JSON is not necessarily a card
file supported by the current import UI; use the report to arrange conversion.
Disk/copy errors, unsafe paths and generated-state validation failures still stop
the transaction. No blanket exception suppression is used.

## First adoption

The Python-era skill already starts review through this unchanged address:

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh
```

Publish that installer, `bootstrap-manifest.json` and `tavern-updater-bootstrap.py`
beside the full bundle. Bootstrap validates hashes, stages the target updater
privately and returns a transaction-bound review/apply command. It does not
refresh an active skill before apply. App/MCP/data/AGENTS and all active skills
stay unchanged until apply. Old `apply --plan <id>` resolves
only the pinned Bootstrap review, never a freshly recomputed digest. SHA-256 is
integrity binding, not an independent publisher signature.

## Commands

Global `--hermes-home /exact/home` goes before the operation. The source and skill
entrypoints accept the same arguments:

```sh
python scripts/update.py --hermes-home /opt/data fetch --tag <approved-tag> --destination <new-private-directory>
python scripts/update.py --hermes-home /opt/data review --release-dir <directory> --manifest-sha256 <sha256>
python scripts/update.py --hermes-home /opt/data apply --transaction <review-path> --expected-plan <digest> --confirm
python scripts/update.py --hermes-home /opt/data rollback --transaction <review-path> --expected-plan <digest> --confirm
python scripts/update.py --hermes-home /opt/data status --transaction <review-path>
```

Review checks archives, per-file hashes, traversal, symlinks, duplicate members,
size limits, the full inventory and current target hashes. Apply checks again.
Whole app/MCP/ops and managed skill directories are replaced after preparation.
Review lists unknown files leaving active paths; they stay in recovery. Supported
custom server/frontend plugin locations are preserved explicitly. Inspect local
code customizations before approving.

Each new review owns a private engine snapshot whose complete file inventory is
bound to the plan digest. Apply/rollback route to that engine before maintaining
the installation; replacing installed ops cannot change the transaction engine.
The skill never executes a historical global Bootstrap pointer. If installed ops
are absent, use the explicitly returned Bootstrap command, not a guessed version.

The desired inventory includes unchanged AGENTS and skill files. Updater 2.0.0
could mistake unchanged AGENTS for a retired file during a second update; use
2.0.1 or later. Existing transaction plans made by the flawed version must be
reviewed again, not applied unchanged.

## Recovery and activation

Plans, backups and receipts live under `tavern-updates-v2/review-*`, outside skill
discovery. `receipt.json` records file intents so interrupted operations can use
the matching rollback command. Recovery includes configuration; keep it private
and retain the latest usable backup until acceptance.

New releases have one directory-transaction writer. Legacy file receipts retain a
recovery-only adapter, not another apply path. `status` does not acquire maintenance,
start services, repair PID files or mutate receipts. It reports the latest
review/attempt unless an exact transaction is selected, and samples the current
owned process/health endpoint separately. An old `rolled-back` receipt does not
prove the server is still running now. `liveware: not-verified` and gateway
activation states must not be presented as verified by a local HTTP/MCP probe.

The updater restarts Tavern through its Node lifecycle and probes a fresh
read-only MCP process. It does not restart the Hermes process executing the
update. `installed-awaiting-hermes-reload` requires [owner activation](activation.md):
tell the owner to send `/restart` in ClawChat and wait for Hermes' restart
notification. It reloads the gateway without requiring an already loaded Tavern
bridge and retains the conversation. Installation and activation are distinct
checks. Liveware registration/bindings, cookies, account settings and user data
are not release assets. In particular, unchanged Liveware bindings are not proof
of correct entry routing after a Python-to-Node upgrade: the original two root
bindings relied on forwarded-host routing, whereas Node's Story Profile entry
uses `/_liveware/story-profile`. Verify both actual app entries independently;
a local `/actor.html` HTTP 200 does not establish correct Liveware routing.

## Limits of this recovery

Recovery includes complete project state and USER.md/MEMORY.md, not the whole
Hermes home, and restores the prior running/offline condition. New user edits
after successful installation block later rollback instead of being discarded.
Pause chats and external writers first. Busy Python jobs or unknown processes
block maintenance; supervisors require coordination. Dependency space is estimated,
not guaranteed. Retain recovery until target-host acceptance; a candidate is not
an accepted stable release.
