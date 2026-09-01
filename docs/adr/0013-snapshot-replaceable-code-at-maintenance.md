# ADR 0013: Snapshot Replaceable Code at Maintenance

- Status: Accepted
- Date: 2026-09-01

## Context

Review and apply are separated by dependency preparation and may span tens of
seconds. Tavern can legitimately create or update generated files inside its
managed code tree during that interval. Treating every reviewed target hash as
an immutable precondition caused native upgrades to fail on files such as
`public/dist/nora/entry.js` before any switch occurred.

User-owned state and host configuration have different semantics from managed
release code. Combining both in one target-consistency rule made harmless code
changes block updates without providing additional data protection.

## Decision

For an existing Node installation:

- The downloaded release manifest, staged source, installed-release baseline,
  `AGENTS.md`, `config.yaml`, active bridge ownership and service ownership
  remain immutable review inputs. Historical activation receipts are audit
  records and are not rewritten or compared as live configuration.
- Managed Tavern, operations, MCP and official-skill code trees are replaceable
  targets. Their current contents are snapshotted only after Tavern stops, then
  backed up and replaced.
- The atomic switch compares each replaceable target with that post-stop
  snapshot. A writer that changes code after maintenance begins still aborts
  the switch.
- User data is not parsed, copied or compared during native code updates.
- User-installed Tavern plugins are inventoried again after Tavern stops, so a
  plugin added after review is preserved in the replacement tree.

The one-time Python migration keeps its full copied-state transaction because
it actually transforms legacy data.

## Consequences

- Runtime-generated managed files no longer create review/apply conflicts.
- Concurrent edits to user-owned host configuration still fail before shutdown.
- User plugins added during dependency preparation are retained.
- Backups contain the exact code present immediately before replacement, making
  rollback authoritative without making live code an immutable review input.
- Release hashes are checked before startup. Generated runtime output after
  startup cannot turn a healthy installation into a checksum failure.
