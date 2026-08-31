# Nora Tavern Domain Language

Nora Tavern presents persistent interactive stories as Worlds while using SillyTavern as a compatibility engine. This language keeps Nora product identity separate from compatibility-engine bindings.

## Story Identity

**World**:
A persistent story container with one stable identity, one default Story Session, referenced story resources, and independently reported capability readiness.
_Avoid_: Character, card, chat, registry entry

**World ID**:
An opaque, stable identity for a World that survives display-name, Runtime Card, Story Session, and compatibility-binding changes.
_Avoid_: Chat ID, avatar, source hash, import ID

**Story Session**:
A persistent conversation belonging to one World. A World has one default Story Session and may gain additional sessions without changing its identity.
_Avoid_: Chat file, chat ID, conversation file

**Participating Character**:
A character present in a World's scene or prompt context without independently owning the World or triggering a separate generation.
_Avoid_: Runtime Card

**World Cast Snapshot**:
The World's current independent character profiles, persistent states and relationships, distinct from reusable library templates. The player has a reserved identity and is never interchangeable with a participating character.
_Avoid_: Library Card, narrator, MVU data

## Story Resources

**Runtime Card Resource**:
The character-card resource used by the compatibility engine to execute a World. It is referenced by a World but is not the World's identity.
_Avoid_: World, character ID, avatar

**Blank World Runtime**:
A shared internal Runtime Card Resource that lets a World exist without an imported character card. It is compatibility infrastructure, not a Participating Character.
_Avoid_: Blank character, default character, empty card

**Knowledge Resource**:
A referenced body of story knowledge, such as a Worldbook, that may be owned by one World, shared by several Worlds, or external to Nora.
_Avoid_: Worldbook name, World

**ST Binding**:
The current compatibility-engine locator for a Nora object, such as an avatar filename, chat filename, or Worldbook name. It is replaceable and never a product identity.
_Avoid_: World ID, Session ID, Resource ID

## Operations And Capabilities

**Import Operation**:
One user-requested attempt to create a World from an external artifact. Retries of the same operation resolve to the same result; an explicit second creation is a different operation.
_Avoid_: Source hash, World ID, upload

**World Mutation Operation**:
A durable, idempotent backend command that repairs or deletes one World. Its journal owns retry stage and error evidence; the browser never supplies resource paths or ownership.
_Avoid_: UI transaction, direct file deletion, registry patch

**World Tombstone**:
The retained manifest of a deleted World. It preserves identity and operation recovery but is excluded from the authoritative World list and cannot be opened.
_Avoid_: orphan World, active World, hard-deleted manifest

**Capability Set**:
The declared and effective enhanced behaviours available to a World, including Regex, helper scripts, and MVU. Its readiness is independent from the World's basic availability.
_Avoid_: World status, extension timeout

**Capability Attempt**:
One durable, independently retryable readiness check for one declared World capability. It records timing, a stable error code, and positive readiness evidence without reopening or recreating the World.
_Avoid_: World activation, extension presence, hidden timeout

**Capability Runtime Readiness**:
Evidence that a declared capability can execute in the compatibility engine. It does not imply that the current Story Session already contains initialized capability data.
_Avoid_: World readiness, variable initialized

**Capability Data Readiness**:
Evidence that the current Story Session contains the initialized data required by a capability. It may follow Capability Runtime Readiness without making the World unavailable.
_Avoid_: Runtime loaded, World ready

**Activation Plan**:
A short-lived instruction that binds one authoritative World and Story Session to their compatibility-engine resources for browser activation.
_Avoid_: World, ST context, creation transaction

**World Read Model**:
The Nora-facing projection used by UI. It carries World identity, display state, opening state, persona, and capability status; it never carries an avatar filename, character index, chat filename, or raw manifest.
_Avoid_: ST binding, Runtime Card locator, manifest

**World Repair Check**:
A durable, non-destructive backend revalidation of compatibility resources, Story Session identity and binding conflicts. It restores `READY` only with positive evidence and does not recreate or silently delete the World.
_Avoid_: retry import, reconcile, provisional merge
