# Create Blank Worlds Through World Core

- Status: Accepted
- Date: 2026-08-29

A blank World is created by the same durable, idempotent World Core command as an imported-card World. World Core supplies a shared internal Blank World Runtime while every World keeps its own identity and default Story Session; the browser never creates a placeholder character, chat, or World identity.

## Considered Options

- Restore browser-side blank-character creation: rejected because refreshes and partial failures can split World, card, and chat ownership again.
- Create one internal Runtime Card per blank World: rejected because the cards are identical compatibility infrastructure and would accumulate as false characters.
- Reuse one shared Blank World Runtime: accepted because Story Sessions remain independent while the compatibility artifact stays hidden and cannot be deleted with one World.
