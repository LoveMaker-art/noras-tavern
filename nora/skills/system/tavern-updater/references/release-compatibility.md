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
- content-addressed `nora-tavern-module-*.tar.gz` archives

The three complete archives remain the first-install, Python migration and
repair fallback. Native 2.x updates compare the target artifact hashes with the
installed roots and download only changed modules plus the small target updater
module. A complete target tree is assembled off-line from downloaded modules
and matching local files, so files removed by the release cannot survive the
switch.

Changed application, operations and MCP roots are replaced atomically. Four
official skills and the Tavern block in `AGENTS.md` are updated only when their
target content differs. Existing native `tavern-state` remains in place, so
Worlds, chats, model configuration and Story Profile data are not migration
inputs.

Tavern and MCP dependencies are reused when their lock-file hashes match the
installed trees. `npm ci` runs only for a changed root whose dependency lock no
longer matches. Tavern stays running for operations-, MCP- and skill-only
updates.

The updater owns the `mcp_servers.nora` runtime paths and permission mode. It
sets the official Nora MCP to `operator`; write tools still enforce their own
explicit confirmation and model-call authorization requirements. Other MCP
servers and unrelated Hermes configuration remain unchanged.

For a Python-era installation, the updater converts a private state copy.
Compatible records become Node Worlds. Unsupported records are left in the
timestamped backup and reported; they do not prevent the program update.

The updater uses one direct installation flow. The only retained
installation backup is `HERMES_HOME/tavern-backups/<timestamp>-<version>-<id>`.
It is used immediately if the new local Tavern fails to start and is kept for
manual recovery after success.
