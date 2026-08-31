# Updater implementation — local verification, not a production release

This document supersedes the operational instructions in the earlier
`UPDATER-ACTIVATION-LOCAL-VERIFICATION-20260831.md` and the updater sections of
`MONOREPO-RELEASE-20260831.md`. Those files retain historical evidence.

## Scope

The World/ST/MVU and Story Profile generation implementations are unchanged.
This refactor concerns release entrypoints, exact runtime ownership, whole-tree
transactions, existing Liveware integration, recovery and owner handoff.
Local implementation is not permission to deploy, push, publish or restart the
owner's machine. Production update testing remains the owner's action.

## Execution contract

- Bootstrap stages a verified private engine. Review leaves active skills,
  programs, user state and host configuration unchanged.
- Each plan binds its complete engine snapshot. Apply and rollback delegate to
  that snapshot rather than a historical global Bootstrap pointer.
- New updates use one whole-directory transaction implementation. The legacy
  file-level adapter can recover old receipts but cannot create new updates.
- Runtime lifecycle, updater and startup recovery share exact process identity
  and the installation maintenance lock. PID files alone do not prove ownership.
- Receipts exist before dependency preparation. Pre-maintenance refusal, active
  maintenance, installation, recovery failure and no-op are distinct outcomes.
  Phase output and read-only status derive from these records.
- A repeated identical release does not stop the process, repeat migration or
  replace the previous successful transaction's recovery authority.
- Python data is converted on a copy; current Node data is validated. Models
  come from the target configuration only. Shared projections and host context
  participate in bounded recovery.

## Three Liveware operations, one implementation

`liveware_integration.py` owns the platform protocol, with an external adapter
substituted in isolated tests. `provision.sh` delegates to explicit initialization;
`bringup-native.sh` and the gateway startup hook use existing-installation recovery.
The updater invokes the same module within its transaction.

Initialization alone may create missing Apps. It checks both identities before
creating, records each result separately and refuses to repeat uncertain creation.
Updates and startup never create/delete App identities or silently synchronize
models. The actual installed hook files, not only copies under skills, are
reviewed and switched; customized hook files require review.

Tavern uses the local root; Story Profile uses `/_liveware/story-profile`. Local
HTML title/application metadata and PNG icons are checked before platform writes.
The two saved App IDs are retained. Launcher registration changes are journaled,
queried afterward and restored only when the current state is still recognized.

### Unclosed platform limitation — release gate remains

The inspected Liveware CLI returns backend mode and route but does **not** expose
a tunnel's original local upstream. The local Liveware login token also did not
authorize direct public App-page reads in the inspected installation (403).

Accordingly `binding-acknowledged` proves a successful CLI bind and separately
verified local/launcher metadata, **not** independently verified public routing or
the user's icon cache. If a bind was attempted and later recovery is needed, the
original upstream cannot safely be guessed. Local recovery can finish while the
receipt remains `integration-pending`; new apply/startup refuses to proceed.
Revisiting external recovery must not stop an already restored local runtime.

The approved goal of automatic original-binding compensation and authenticated
external-entry verification is therefore **not fully achieved**. Closing it
requires a supported platform read/verification interface or an explicitly
approved owner platform procedure. Local adapter tests do not establish that
the live platform performed those mutations. Do not advertise this as stable.

## Owner activation

New releases do not install/enable the former confirmation bridge. Unchanged
official or previously managed bridge files are retired transactionally; pending
requests are superseded. Customized files and active/interrupted reset requests
block retirement. Historical receipts remain readable.

After successful installation the owner sends `/restart` in ClawChat. The updater
does not restart Hermes, change its global supervisor or reset conversations.
Actual gateway MCP/skills/context must be checked after owner activation; a new
standalone MCP process is not evidence of gateway reload.

## Verification surfaces

`ops/tests` covers refusal, permissions, process identity, locks, preparation,
no-op, partial platform operations and recovery. `verify_rename_recovery.py`
abruptly exits after each executed rename in a real filesystem transaction.
`verify_python_release.py` exercises a disposable original Python-data layout via
the actual bundled Bootstrap and installed skill CLI. `verify_full_release.py`
updates and rolls back an actual isolated Node process with a real MCP probe.
`verify_installed_hermes_skills.py` uses a local Hermes loader on an isolated copy.

Production claims additionally need the actual Linux/ClawNest lifecycle, an
online original Python business process, authenticated Liveware entries and the
owner's gateway activation. Offline data migration and macOS process tests cannot
substitute for those outcomes. Final evidence must identify the exact bundle;
uncommitted candidate packages are local test artifacts, not public releases.
