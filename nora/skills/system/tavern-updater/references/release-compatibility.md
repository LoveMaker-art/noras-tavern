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

Changed application, operations and MCP roots are replaced atomically. Managed
skills and the full managed `AGENTS.md` are updated only when their
target content differs. Existing native `tavern-state` remains in place, so
Worlds, chats, model configuration and Story Profile data are not migration
inputs.

Tavern and MCP dependencies are reused when their lock-file hashes match the
installed trees. Independent Linux updates can prepare missing dependencies in
the verified temporary target tree with `npm ci --omit=dev --ignore-scripts`.
The installation lock remains held; the old service is still running. Both
the dependency manifests and unchanged package/lock files must pass before
stopping or replacing the old program. Locks requiring install scripts are
rejected. Desktop-managed updates require bundled or reusable dependencies;
they do not enter this Linux preparation path.
Tavern stays running for operations-, MCP- and skill-only
updates on standalone installations. Launcher-managed updates restore the prior
Nora/Tavern service selection after validation.

The updater owns the `mcp_servers.nora` runtime paths and permission mode. It
sets the official Nora MCP to `operator`; write tools still enforce their own
explicit confirmation and model-call authorization requirements. Other MCP
servers and unrelated Hermes configuration remain unchanged.

For a Python-era installation, the updater converts a private state copy.
Compatible records become Node Worlds. Unsupported records are left in the
timestamped backup and reported; they do not prevent the program update.

The updater uses one direct installation flow. The only retained
installation backup is `<verified-install-root>/tavern-backups/<timestamp>-<version>-<id>`.
It is used immediately if the new local Tavern fails to start and is kept for
manual recovery after success.

## Historical independent Linux entry

Old installed skills are immutable until the update runs. Some call the raw
installer; 2.4.3 and later published bootstraps also require desktop credentials
before obtaining the replacement runner. Installing a desktop launcher is not
the remedy for a standalone Linux instance.

After owner authorization to update, resolve the actual Hermes interpreter,
Hermes home and Tavern root from the existing configuration. Use the official
`install-tavern-updater.sh` from the selected published release with
`--apply --confirm --hermes-home <verified-home> --install-root <verified-root>`.
The official entry downloads and checks the release catalogue, bootstrap
digest and target runner, then updates the same installation. Do not execute a
copied raw `update.py`, invent its flags, erase retry/transaction records or
replace user configuration to make the update proceed.

If a prior owned transaction is incomplete, the standalone updater first
restores and ends that transaction. Verify the restored version, health and
data before a separate update attempt. Recovery completion alone is not a
successful upgrade. Python-era migrations have a distinct service/data
contract; report an unsupported layout explicitly instead of promising that
every historical 1.x layout is covered by the native 2.x path.

The skill and desktop UI share one updater and one native writer lock. Each
submission lives under `<noraHome>/installer/update-jobs/<requestId>` and points
to the canonical `<noraHome>/installer/operations/<operationId>/operation.json`.
The submission directory holds a verified immutable runner and diagnostics; it
is not a second outcome journal. No GUI heartbeat or launcher session is needed.
A caller receives acceptance only after the controller owns the lock and durable
operation. Reconnecting callers read that same operation. APP replacement keeps
its separate guarded handoff and cannot become a prerequisite for content updates.
