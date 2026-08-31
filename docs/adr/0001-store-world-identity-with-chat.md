# ADR 0001: Store World Identity With The Chat

## Status

Accepted

## Context

Nora presents a World as the primary product object, while ST identifies a running story through a character avatar plus a chat file name. Those ST identifiers can change and therefore cannot be the durable identity of a World.

We considered a separate World registry, a deterministic ID derived from ST paths, and metadata stored in the chat header.

## Decision

Store the canonical World ID in the chat metadata under `nora_world.id`. Existing Python-migrated worlds use their legacy production ID as a deterministic migration identity until the canonical metadata is saved. A new ST chat receives an opaque ID on its first successful Nora activation.

World activation is a transaction at the Nora runtime seam: select the ST character and chat, verify the resulting context, persist missing World metadata, verify persistence, and roll back to the previous context if any step fails.

## Consequences

- The story data and its identity move, export, and restore together.
- Renaming a chat or character does not change the World ID.
- The recent-chat projection must request chat metadata.
- A previously untouched ST chat has a provisional in-memory ID until its first successful activation.
- Failed activation cannot leave the UI claiming a different active World from the ST runtime.

