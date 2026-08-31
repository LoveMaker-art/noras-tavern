# Worlds and character cards

## Locate or inspect

- `nora.world.list` finds authoritative worlds. `nora.world.inspect` supplies
  the selected world's details and activation plan; `nora.world.snapshot`
  supplies activation state. Use returned identifiers, not guessed paths.
- `st.character.list` / `st.character.inspect` inspect reusable library cards.
  `st.worldbook.list` / `inspect` / `entries` inspect worldbooks. A readable
  worldbook is not evidence that it belongs exclusively to the selected World.
- `nora.world.open_plan` reads a plan: it neither opens a page nor executes MVU.
  The present controls have no general world-switch action. If asked to open a
  world automatically, explain that limit rather than claiming an inspection opened it.

## Create or import

Choose the single matching operation:

| User intent | Tool | Inputs to resolve |
| --- | --- | --- |
| New blank world | `nora.world.create` | name, optional approved Persona fields |
| New world from an existing library card | `nora.world.import_library` | actual library avatar |
| Import a supplied card as a world | `nora.world.import` | real filePath in this instance's configured allowed upload directory |

These tools own parsing, bindings and persistence. Pass the original supported
card, not a model-normalized rewrite of its scripts or unknown metadata. If the
attachment is not available in the permitted directory, report that prerequisite;
this MCP does not provide an unrestricted file-upload operation.

Use a stable idempotencyKey per intended creation. Poll the returned operationId
with `nora.operation.get` when present. Inspect the completed world's binding.
Two intentional new worlds use two keys; a timed-out attempt keeps its original
key. For a confirmed failed operation use `nora.operation.retry` only when its
state permits it, rather than starting a replacement import.

Report stored-world creation separately from live-page capability activation.
An imported card can be stored correctly while its Helper/MVU still awaits
execution on a page. The agent must not mark capabilities READY itself.

## Change the current world's card

Use the live-page control protocol in SKILL.md:

1. `cards.inspect` reads the world's runtime card and revision.
2. `cards.opening` changes its opening template using text and expectedRevision.
   `cards.fields` changes supported narrative fields (including name, description
   and personality) using patch and expectedRevision.
3. Read back the target fields and check librarySourceUnchanged /
   existingChatUnchanged in the result.

These actions do not change the reusable library source or existing chat history.
If “change the opening” means editing the first saved message, resolve that intent
and use the history-edit workflow instead; it may delete subsequent messages.
Ownership rejection is a real constraint, not permission to edit the source card
through another path. These writes target the World runtime card, not the library
original. Library-original writes are not exposed by this daily MCP.

## Right-panel settings

Discover these actions through the running server's `nora.control.catalog` first.
If absent, the deployed server is older than this skill; do not invent tools or
edit files to bypass it. All operations below use the live-page protocol in SKILL.md.

| Requested change | Read action | Write action / parameters |
| --- | --- | --- |
| My character (Persona), or World name | `world.inspect` | `world.update`: patch `{persona:{name,description}}` or `{name}`, expectedRevision |
| World background used in the current session | `scenario.inspect` | `scenario.update`: text, expectedRevision; empty text restores the card's background |
| A Worldbook entry | `worldbook.list`, then `worldbook.inspect` with name | `worldbook.update-entry`: name, entryId, patch, expectedRevision |
| Delete one Worldbook entry | `worldbook.inspect` | `worldbook.delete-entry`: name, entryId, expectedRevision |
| Switch text model | `models.list` | `models.select`: id, expectedRevision |
| Delete saved custom text model | `models.list` | `models.delete`: id, expectedRevision |

Persona belongs to the authoritative World manifest and applies again when opened.
Do not change the player's Persona by editing the AI character's description.
Background overrides live in session metadata; editing card.scenario may not change
the effective background while an override exists.

Worldbooks: use the returned resource name and entry ID, not a list index guessed
from visible order. Allowed patches: comment, content, key, keysecondary, constant,
disable, selective. Preserve insertion depth/order, extensions, MVU metadata and
other entries. Only owned runtime resources are writable by these actions. Shared
or external books require a separately authorized design, not an ownership bypass.
Do not edit the imported embedded original when the prompt uses a materialized book.
Deleting an entry is distinct from deleting the entire book (not exposed).

Models: this is the GLOBAL text model configuration, not per-world MVU settings.
Select a returned model ID. Hermes remains available and cannot be deleted; deleting
the active custom model selects the same fallback as the UI. No text generation is
requested by switching, although the existing backend may perform a status check.
New-provider/key entry remains in the existing model form; do not ask for keys in
chat or pretend models.select creates a new model configuration.

Verify by repeating the corresponding read. For World edits, inspect the saved
manifest too; saved=true with runtimeApplied=false means reopen before claiming
the live Persona changed. Model persistence errors can occur after runtime changes;
inspect state before retrying. On a stale Worldbook revision, reread and reapply the
user's intended entry patch instead of replacing the whole book.

## Card frontend versus Tavern shell

Card-owned HTML/CSS and Helper scripts/Regex use the plugin reference and existing
script authorization. The top Tavern World title is a separate shell renderer;
currently it renders the World name and has no MVU-variable binding operation.
Clarify whether “title” means the card's own frontend or the Tavern header. Do not
rename the World to a one-time variable value or inject parent-page DOM code and
claim a persistent reactive title binding. For background images, font presets,
palette and reading surfaces, read [world visuals](world-visuals.md); these existing
visual options have dedicated theme controls, not model/plugin settings.

## Repair or delete

Inspect the exact world before `nora.world.repair` or `nora.world.delete`.
Use the supported operation, its idempotencyKey and returned receipt. Repair is
not a general story rewrite. Delete only the world the user selected; do not infer
permission to delete its library source, sibling worlds or persistent instance data.
Verify the resulting world state/list and operation outcome.
