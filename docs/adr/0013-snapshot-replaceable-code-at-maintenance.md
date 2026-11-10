# ADR 0013: Snapshot Replaceable Code at Maintenance

> Core scope restored — 2026-11-10. This decision also governs core runtime ownership and maintenance; moving desktop source did not retire it. Restored from Git revision `09b9895`. Dated implementation statements below retain their original scope and are not fresh acceptance results. Current product/data rules take precedence: [core product scope](../product/README.md#validation-boundaries) and [core maintenance](../core-maintenance.md). Desktop implementation and UI remain outside this repository.

- Status: Accepted
- Date: 2026-09-01
- Clarified: 2026-10-12, aligning data protection with the accepted existing-instance updater contract of 2026-09-10.
- Clarified: 2026-11-04, applying the current [validation scope](../product/README.md#validation-boundaries) to newly created ordinary update transactions.

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
- Newly created ordinary native program transactions preserve the active
  `tavern-state` without taking a tree snapshot or making its content an
  acceptance condition. Bundled managed extensions belong to the versioned
  program tree. Maintenance verifies the current service and instance binding
  without invoking the world reader. Existing recovery records retain their
  original protocol. Damaged-installation repair uses the verified candidate
  as the reader and requires exact preservation under its separate repair
  contract. Repair does not authorize a legacy-data conversion.
- User-installed Tavern plugins are inventoried again after Tavern stops, so a
  plugin added after review is preserved in the replacement tree.

The one-time Python migration transforms legacy data. Its authoritative copy and
conversion start only after confirmed shutdown. The original is retained for
rollback, including the final write before shutdown. Only a recognized unsupported
input format can use a fresh complete archive copy; converter crashes, timeouts,
I/O errors and invalid output fail the transaction. Individual unsupported records
remain governed by the converter's existing explicit archive rules. A direct
legacy installation without a service that can be restored is refused before
shutdown; the updater does not invent a process-restart mechanism.

Admission measures future backup, migration and possible metadata-restoration
copies per destination volume before host snapshots or shutdown, and rechecks
after shutdown with current state sizes. Migration also rechecks remaining
restoration headroom after conversion. Existing candidate files and backups
already consume reported free space; same-volume renames do not require another
payload copy. The estimate reserves 10% of copied bytes, 4096 bytes per entry and
65536 bytes per volume for allocation and transaction overhead. It is not a disk
reservation: concurrent writers or conversion growth can still exhaust storage,
so actual copy/write failures remain failures and recovery preserves original
data and the available failure evidence. No backup is deleted to pass admission.

## Consequences

- Runtime-generated managed files no longer create review/apply conflicts.
- Concurrent edits to user-owned host configuration still fail before shutdown.
- User plugins added during dependency preparation are retained.
- Backups contain the exact code present immediately before replacement, making
  rollback authoritative without making live code an immutable review input.
- Release hashes are checked before startup. Generated runtime output after
  startup cannot turn a healthy installation into a checksum failure.
- Partial repair and actual data migration reserve space for their own data
  protection. Ordinary updates reserve space for program staging and owned
  metadata. A non-managed component-only update that replaces no runtime and
  performs no migration can keep Tavern running. Launcher-managed system
  updates continue to stop their target runtime before program replacement.
