# ADR 0012: Separate Runtime Ownership from Process Instance Identity

- Status: Accepted
- Date: 2026-09-01

## Context

The updater records a running Tavern process before maintenance. Linux process
start ticks, process groups and sessions are useful for detecting PID reuse
between two observations made during one stop operation. They are not stable
across Liveware container checkpoint, restore or host migration.

Treating those kernel coordinates as durable installation identity caused a
healthy, uniquely owned Tavern process to be rejected at `stop-runtime`, even
though its executable entry, arguments, working directory, OS owner, configured
data root, port and listener ownership all still matched.

## Decision

Runtime process handling exposes two distinct comparisons:

- `same_process` compares one observed process instance during a bounded
  operation. It includes volatile kernel identity and prevents signalling a PID
  that was reused or changed after inspection.
- `same_runtime` compares durable ownership evidence across updater invocations
  and container lifecycle events. It compares the exact command, working
  directory and OS owner, while ignoring PID, kernel start ticks, process group
  and session.

The lifecycle additionally verifies the configured `--configPath`,
`--dataRoot`, `--port` arguments and the unique listener immediately before
maintenance. PID files remain discovery hints, not authority. Read-only status
checks do not rewrite them.

## Consequences

- Liveware checkpoint/restore no longer creates a false process-identity
  conflict.
- A different program, command, working directory, OS owner, configuration or
  listener is still rejected before any signal or directory switch.
- Durable recovery receipts survive container lifecycle changes, while the
  final pre-signal observation still detects real PID reuse.
