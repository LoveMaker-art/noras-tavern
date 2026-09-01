# Direct release contract

A release contains:

- `release-manifest.json`
- `SHA256SUMS`
- `nora-tavern-app.tar.gz`
- `nora-tavern-ops.tar.gz`
- `nora-tavern-nora-mcp.tar.gz`
- `bootstrap-manifest.json`
- `tavern-updater-bootstrap.py`
- `install-tavern-updater.sh`

The three archives replace `apps/tavern-runtime`, `apps/tavern-ops` and
`apps/nora-mcp`. Four official skills and the Tavern block in `AGENTS.md` are replaced from the ops
archive. Existing native `tavern-state` remains in place, so Worlds, chats,
model configuration and Story Profile data are not migration inputs.

For a Python-era installation, the updater converts a private state copy.
Compatible records become Node Worlds. Unsupported records are left in the
timestamped backup and reported; they do not prevent the program update.

The updater uses one direct installation flow. The only retained
installation backup is `HERMES_HOME/tavern-backups/<timestamp>-<version>-<id>`.
It is used immediately if the new local Tavern fails to start and is kept for
manual recovery after success.
