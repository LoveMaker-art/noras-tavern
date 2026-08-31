# ADR 0003: Isolate The ST Compatibility Boundary

- Status: Accepted
- Date: 2026-08-26

## Context

Nora uses the ST frontend runtime to preserve complex-card, MVU, EJS,
Worldbook, message edit, and Swipe compatibility. Nora previously exposed the
raw ST context to its UI and World runtime. Product code therefore depended on
ST DOM state, event names, metadata methods, and character selection details.
That made UI changes risky and allowed ST implementation details to spread.

## Decision

Raw ST context access belongs only to `nora-compat`, `nora-adapters`, and the
runtime composition root.

The Nora UI receives a projected state snapshot and Nora commands from the ST
runtime adapter. It does not receive `getContext`, ST events, or ST persistence
methods.

The World runtime owns World transactions and depends on a World adapter. The
adapter translates activation, metadata, persona, embedded Worldbook, chat
deletion, and chat-close operations into ST calls.

The World registry client receives request headers rather than an ST context.

## Consequences

- Complex-card execution remains provided by ST behind a stable Nora boundary.
- Nora product code can change without importing ST UI or context conventions.
- ST upgrades are localized to the compatibility kernel and adapters.
- New Nora features must extend a Nora interface instead of reading raw ST
  context or hidden ST DOM controls.
- Contract tests reject raw ST context access outside the compatibility
  boundary.
