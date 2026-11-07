# Create Blank Worlds Through World Core

- Status: Partially superseded; the shared Runtime Card choice below is historical. Durable creation through World Core remains accepted.
- Date: 2026-08-29

## Current Applicability

The current [creation rules](../product/tavern.md#story-flow) require stable World identity, a default Story Session and independent runtime resources. New blank Worlds receive World-owned Runtime Cards, as described by the [World Core implementation boundary](../../app/engine/sillytavern/src/nora-world-core/README.md#identity-libraries-and-resource-ownership) and implemented in [the backend materializer](../../app/engine/sillytavern/src/nora-world-core/st-backend-materializer.js). The original shared-card choice below does not describe new creation. Existing shared or external bindings retain their protection; this documentation update does not migrate or delete them.

## Original Decision (2026-08-29)

A blank World is created by the same durable, idempotent World Core command as an imported-card World. World Core supplies a shared internal Blank World Runtime while every World keeps its own identity and default Story Session; the browser never creates a placeholder character, chat, or World identity.

## Considered Options

- Restore browser-side blank-character creation: rejected because refreshes and partial failures can split World, card, and chat ownership again.
- Create one internal Runtime Card per blank World: rejected because the cards are identical compatibility infrastructure and would accumulate as false characters.
- Reuse one shared Blank World Runtime: accepted because Story Sessions remain independent while the compatibility artifact stays hidden and cannot be deleted with one World.
