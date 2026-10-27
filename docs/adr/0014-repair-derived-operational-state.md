# ADR 0014: Repair Derived Operational State Instead of Treating It as Authority

- Status: Accepted
- Date: 2026-09-01

## Scope clarification — 2026-10-27

[Product baseline 1.35](../product/README.md#validation-boundaries) limits the
historical decision below: user content and user-data backups are not immutable
program-maintenance evidence. Their edits, replacement or deletion do not by
themselves block program startup, update, rollback or data-retaining uninstall.
Program rollback preserves current user content. A source check constrains the
specific operation that would consume that source; actual competing program
writes still constrain conflicting operations. User-authorized content restore
or configuration changes retain their own operation-specific validation.

The current updater still snapshots and restores whole state and retains some
data/configuration digest gates. This implementation gap is recorded as
[L-D07](../product/launcher.md#differences); merging the existing partial fixes
does not implement the full separation. The historical text below records the
earlier decision and must not override the newer product scope.

## Context

The updater accumulated several durable-looking files that are actually hints,
caches or historical evidence: PID files, verified Bootstrap caches, activation
requests and interrupted update receipts. Requiring all of them to remain
byte-identical made harmless container restarts, partial writes and runtime
generated files block later updates or even Tavern startup.

These artifacts do not have the same ownership semantics as user data, release
manifests, host configuration or an unrecovered directory switch.

## Decision

Operational state is classified by effect:

- A release manifest, staged source, target installation identity, user-owned
  host configuration, backup checksum and service ownership are authoritative.
  A mismatch still blocks mutation.
- A PID file is only a discovery hint. A malformed or stale PID falls back to a
  unique process that passes command, working-directory, owner, configuration
  and listener checks.
- A Bootstrap directory is updater-owned cache. Invalid cached bytes are moved
  to a diagnostic quarantine and replaced by the newly downloaded,
  hash-verified updater.
- Historical activation requests remain immutable audit records. Only a valid
  record describing an active reset/activation operation blocks retirement.
- An interrupted update blocks startup or a later update only while it has an
  unrestored directory-switch intent or an unrestored external Liveware action.
  Prepared files and fully restored intents have no active effect.
- Managed release files are verified while the runtime is offline. Successful
  startup is not followed by a whole-tree inventory of mutable live code.
- Normal status polling and startup read typed historical acceptance records;
  they do not hash user-customized skills or configuration. Initialization schema
  1 and installation receipt schema 1 or 2 must have literal successful proof,
  valid versions and commits, consistent identity, and correctly typed boolean
  fields. Invalid records are reported without silently rewriting them. This is
  historical acceptance, not current whole-installation integrity. Explicit
  install/update acceptance retains actual component, binding and runtime checks.

Automatic failure recovery may replace the just-installed managed code tree
even if the failed runtime wrote into it. Explicit rollback after a successful
installation remains strict so it cannot silently overwrite a later user edit.

## Consequences

- Harmless PID/cache/history drift no longer creates unrelated update errors.
- A failed transaction with no remaining active effect cannot lock Tavern out
  of startup or permanently block the next update.
- Suspicious updater cache bytes and failed release trees are preserved for
  diagnosis rather than deleted.
- User configuration, data, external platform changes and concurrent writes at
  the atomic switch boundary retain fail-closed protection.
