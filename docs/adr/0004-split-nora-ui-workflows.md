# ADR 0004: Split Nora UI Workflows Into Deep Modules

- Status: Accepted
- Date: 2026-08-26

## Context

The Nora UI entry owned runtime state projection, dialogs, model profiles,
character-card library workflows, Worldbook editing, shell rendering, and
lifecycle wiring in one file. Those responsibilities changed for different
reasons and made product changes depend on a broad, shared implementation.

## Decision

`nora-ui/index.js` is the composition root for the Nora shell. It owns layout,
render scheduling, user-intent routing, and runtime lifecycle wiring.

State projection and caches belong to `ui-store.js`. Dialog behavior belongs
to `dialog-controller.js`. Model, character-card, and Worldbook workflows
belong to their corresponding controllers.

Controllers receive Nora runtime interfaces and narrow UI helpers through
their factories. They must not import the raw ST context or restore ST UI
controls.

## Consequences

- UI workflows can be changed and tested without expanding the shell entry.
- Runtime state, recent Worlds, and Worldbook caches have one owner.
- Complex-card, MVU, EJS, Worldbook, edit, and Swipe behavior remain behind the
  Nora runtime interfaces established by ADR 0003.
- Contract tests enforce the module boundaries and keep the entry below the
  accepted size limit.
