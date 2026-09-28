# Authorized service operations

Resolve HERMES_HOME and the installed script path as described in diagnostics.md.
Use the existing lifecycle; keep the configured instance and production run ID.

## Start or restart

The maintained `runtime.sh` supports status/start/stop/restart and separate
install/prepare/sync operations. Restart stops and starts the selected run; it
may also reconcile managed extension files/configuration during startup.
Inspect current activity and source/managed-file differences before restarting.
A restart is not a read-only diagnostic and must not discard active generation.

For an authorized restart, record current status, back up any affected managed
files/configuration and run the maintained command for the selected run. Check
local HTTP health and instance identity afterward. If startup fails, inspect
the actual error; do not loop restarts or run dependency installers blindly.

Changing Hermes MCP configuration affects the host, not just Tavern. Inspect
the installed host's supported reload mechanism before proposing it; restart a
gateway only when necessary and explicitly authorized. Never terminate it just
because Tavern's frontend is slow.

## Liveware setup or binding recovery

Load `clawchat-liveware` for current platform procedures. Keep `clawchat-core`
for platform operations it owns. Tavern's maintained scripts remain under
`$HERMES_HOME/skills/creative/tavern/scripts`:

- `provision.sh` is explicit first initialization. It may create missing Apps,
  records each confirmed identity, starts the runtime and aligns its two entries.
  Authenticate with the platform first. A failed query is never an empty list;
  an uncertain creation is recorded and cannot be blindly repeated.
- `bringup-native.sh` starts the existing runtime and binds the two saved App IDs.
  It does not create Apps, synchronize models, log in or restart Hermes.
  It is not a read-only check. Startup hooks use this same existing-only path.

Use those scripts only when all their effects are approved and dependencies
are present. For a narrower binding repair prefer the platform's supported
operation rather than running full provisioning. Reuse existing App IDs.
Read only needed apps.json fields; preserve names/icons/access policy unless
the request includes changing them. Recheck bindings and public response;
registration success does not prove the user's launcher has refreshed.
The installed Liveware CLI cannot read the original local tunnel target.
`binding-acknowledged` is therefore limited evidence. `integration-pending`
requires explicit platform review, not another blind provision/recovery run.

## Configuration and recovery boundaries

Use currently supported semantic configuration interfaces. Scope credential
changes separately from UI selections; real model tests may be paid. Maintenance
does not authorize rewriting world/chat/profile files, deleting broad caches,
upgrading packages or applying a new application version. Release backups belong
to `tavern-updater`; do not improvise a file restore.
