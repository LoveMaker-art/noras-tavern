# Worlds and character cards

## Reusable library material

Separate library storage from applying material to a World. For library reads
and saves, discover the installed `nora.library.list/read/save` schemas. If an
operation is absent, report the missing capability without changing files,
creating a substitute World or restarting services.

| UI category | Meaning and tool kind |
| --- | --- |
| 世界卡 | Complete card: list kind `card`, file import via `nora.library.import_card` |
| 角色 / 我的角色 | Player identity: `persona` |
| 角色 / 其他角色 | Reusable character profile: `character` |
| 世界书 | Lore entries: `worldbook` |

### Find and save

1. Resolve whether the user wants a read, a library save, or a World change.
   An explicit save request authorizes that save; ask about ambiguous targets
   or changed scope, not for redundant approval. A read request stays read-only.
2. Read the selected source through the supported tools, or use the material
   explicitly supplied by the user. Identify the exact persona, character or
   book. Keep a World runtime narrator card separate from an independent cast
   member. Do not infer multiple people from prose or rewrite source content
   merely to store it. Substantial card authoring remains with `nora-cardforge`.
3. Preserve supported data. Persona uses name and description. Character uses
   name, description, personality, activation and, when present and supported,
   its structured profile. Preserve enabled state and trigger parameters.
   Worldbook data preserves complete entries, including disabled entries and
   supported metadata. Profiles are not complete cards: they do not carry
   openings, avatars, executable scripts, Regex or MVU state. Unresolved
   cross-character references and external dependencies must be disclosed.
4. List the relevant kind and inspect same-name candidates before saving.
   Distinguish the library label from the character's own name. Same-kind,
   same-name, equivalent content reuses the existing item; conflicting content
   requires a user-approved distinct library name. Different labels do not
   imply backend content-wide deduplication for profiles or standalone books.
   Let the backend perform its final checks; never overwrite, merge, delete
   duplicates or rename on the user's behalf without the corresponding request.
5. Save with the installed schema and authorized confirm flag. Read back the
   returned profile id or worldbook source, and check the intended name,
   fields, entry count and enabled/trigger state. Interpret reused separately
   from a new save. On an uncertain write result, inspect current state before
   retrying; do not retry under an invented new name.
6. Report the destination category and whether the item was saved or reused.
   State that the current World was not changed. Report normalization or
   unsupported data rather than claiming a complete round-trip without evidence.

### Reuse boundaries

Complete-card creation/import follows Create or import below. The current
`library.save` tool does not store complete cards; use `nora.library.import_card`
for storage only. This does not create or switch a World. Inspect `legacy:true`
catalog items as compatibility snapshots, not proven original source cards.
For an explicitly requested profile or independent-book deletion, read its revision
then use `nora.library.delete`. This is not deletion of a World or an embedded book.

Complete cards use `nora.library.manage_card` with the avatar/revision from a fresh
`library.list(kind:"card")`. `delete` removes that original and its index;
`deduplicate` keeps it and removes content-equivalent unreferenced copies. Read
removed/retained: referenced files are kept, and deleted=false is not success.
World copies/chats are preserved. Unreferenced, unchanged source archives can be
removed with the original; the receipt reports retained references or changed
archives. If another
duplicate remains referenced, it may still appear in the catalog. Legacy runtime
snapshots are not deletable library originals.

For an authorized file export, use `nora.export`: card target is its avatar and
supports PNG/JSON; preset target is its name; worldbook target is its returned
`source.name`, not its display label; profile target is its ID.
The latter three export JSON, with profiles retaining the Nora profile envelope.
The result is a new local file under the configured exports directory, not an
external upload. Return its actual path; do not paste sensitive raw contents.

Discover `world.library.apply` through `nora.control.catalog`; application requires
the intended live World/Session. Read the selected library item and `world.inspect`
before writing. Saving or reading alone does not add material to a World.

- Persona: use `world.update` with `{persona:{name,description}}`; this replaces
  the player's identity, not another character.
- Character: use `world.library.apply` with `input.character` containing a new
  stable `id`, `operation:"create"` and `patch` from the read profile's `data`.
  Preserve supported profile and activation fields; never substitute the narrator.
- Worldbook: use `input.source` and `input.source_revision` from the selected
  book read. For an embedded book, source is `{kind:"card",name:<avatar>}`;
  for a standalone book, `{kind:"book",name:<returned name>}`. Preserve all
  entries, including disabled ones. Do not turn the book into one prose setting.

Pass `expectedRevision` from `world.inspect`. Character and book can share one
application when requested together; World Core commits them together or rejects
the change. It copies the book into this World and reuses an existing source
binding. A saved template is not a live link to existing World copies. Importing
material does not authorize script execution or a model call; capabilities may
still await activation. Inspect the World and books afterward.

## Locate or inspect

- `nora.world.list` finds authoritative worlds. `nora.world.inspect` supplies
  the selected world's details and activation plan; `nora.world.snapshot`
  supplies activation state. Use returned identifiers, not guessed paths.
- For library cards, use `nora.library.list` with kind `card`. ST character
  list/inspect tools also include runtime records; use them for ST inspection,
  not as the library catalog. Treat legacy snapshots separately from originals.
  `st.worldbook.list` / `inspect` / `entries` inspect worldbooks. A readable
  worldbook is not evidence that it belongs exclusively to the selected World.
- `nora.world.open_plan` reads a plan: it neither opens a page nor executes MVU.
  To switch a connected page, read `page.inspect`, then use `page.world` with its
  revision and targetWorldId. Open editors or an unsent draft block switching.
  `page.open` opens supported panels; `page.draft` changes unsent text only.
  `page.library` selects cards/character/persona/worldbooks; `page.sidebar` sets
  the rail/settings drawer state. `page.close` uses the same editor confirmation
  as the UI; the user may need to confirm locally. Inspect applied and page state
  instead of claiming a declined close succeeded. Navigation preserves protected
  editors and does not provide arbitrary DOM control.

## Create or import

Choose the single matching operation:

| User intent | Tool | Inputs to resolve |
| --- | --- | --- |
| New blank world | `nora.world.create` | name, optional approved Persona fields |
| New world from an existing library card | `nora.world.import_library` | actual library avatar |
| Import a supplied card as a world | `nora.world.import` | real filePath in this instance's configured allowed upload directory |
| Save a supplied complete card only | `nora.library.import_card` | permitted filePath; no World creation |
| Restart from current World settings | `nora.world.restart` | worldId, new name, inspected expectedRevision and idempotencyKey; preserves source World |

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

First inspect the World. A Python-migrated World may contain independent
`story_context.characters`. Its Runtime Card is a narrator resource, not any one
of those characters. The card-field controls below do not edit that cast.
Use `world.inspect` to read independent characters and `world.update` to edit
one by ID, as described below. Do not change the narrator's description and claim
the participating character was updated.

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
original. Only the dedicated `library.card-regex`/`library.card-regex-update` actions
edit Regex in an inspected non-legacy library card; they do not synchronize Worlds.

## Right-panel settings

Discover these actions through the running server's `nora.control.catalog` first.
If absent, the deployed server is older than this skill; do not invent tools or
edit files to bypass it. All operations below use the live-page protocol in SKILL.md.

| Requested change | Read action | Write action / parameters |
| --- | --- | --- |
| My character (Persona), or World name | `world.inspect` | `world.update`: patch `{persona:{name,description}}` or `{name}`, expectedRevision |
| Independent character | `world.inspect` | `world.update`: patch `{character:{id,operation,patch}}`, expectedRevision |
| New World setting | `world.inspect` | `world.setting.add`: setting `{type:"constant" or "trigger",title,content,keys?}`, expectedRevision |
| Apply a library character/book | Library read, then `world.inspect` | `world.library.apply`: input as above, expectedRevision |
| World background used in the current session | `scenario.inspect` | `scenario.update`: text, expectedRevision; empty text restores the card's background |
| A Worldbook entry | `worldbook.list`, then `worldbook.inspect` with name | `worldbook.update-entry`: name, entryId, patch, expectedRevision |
| Delete one Worldbook entry | `worldbook.inspect` | `worldbook.delete-entry`: name, entryId, expectedRevision |
| Switch text model | `models.list` | `models.select`: id, expectedRevision |
| Add text model | `models.list` | `models.create`: profile, apiKey, expectedRevision; shared UI connection test and save |
| Delete saved custom text model | `models.list` | `models.delete`: id, expectedRevision |

For an additional World rule, use `world.setting.add` and verify the original
entries remain alongside the new entry. `cards.fields.system_prompt` changes the
card's main-prompt override; it is not an append-to-settings operation. New Worlds
own independent runtime copies. World edits stay in that World; saving a changed
card, character or Worldbook back to the library requires an explicit user request.

Persona belongs to the authoritative World manifest and applies again when opened.
Do not change the player's Persona by editing the AI character's description.
Background overrides live in session metadata; editing card.scenario may not change
the effective background while an override exists.

Independent characters use `operation:"create"`, `"update"` or `"delete"`.
For create, choose a stable new ID and keep it on retries. For update/delete,
use an inspected ID; `__user__` is the Persona, not a cast-edit target. Supported
patch fields: name, description, personality, profile, persistent_status,
activation. Activation uses `mode:"constant"` or `"triggered"`, `enabled`, and
trigger `keys`; preserve existing secondary keys and trigger parameters. Do not
replace the whole character array. Deletion also removes its relationships.

New settings use `type:"constant"` or `"trigger"` (not `"triggered"`); triggers
require nonempty `keys`. They start enabled, like UI-created settings. To disable,
read the returned book/entry and use `worldbook.update-entry` with `disable:true`.
Do not pass unsupported ST metadata to setting.add; use the whole-book path for
complex imported entries. A setting's persistent key comes from the control's
idempotencyKey, not a new random key inside the request.

For multiple characters or settings, execute sequentially and reread the World
revision before each new write. This is not an all-or-nothing batch. Stop on a
conflict, busy state or uncertain result; report confirmed items without rolling
them back. Reuse the same payload/key for an uncertain transport retry, and inspect
before planning a corrected action. `saved:true` with `runtimeApplied:false` or
`reopenRequired:true` means stored but not confirmed live; do not add it again.

Worldbooks: use the returned resource name and entry ID, not a list index guessed
from visible order. Allowed patches: comment, content, key, keysecondary, constant,
disable, selective. Preserve insertion depth/order, extensions, MVU metadata and
other entries. Only owned runtime resources are writable by these actions. Shared
or external books require a separately authorized design, not an ownership bypass.
Do not edit the imported embedded original when the prompt uses a materialized book.
Deleting an entry is distinct from deleting an independent library book via
`nora.library.delete`; the latter must not be used to remove runtime World resources.

Models: this is the GLOBAL text model configuration, not per-world MVU settings.
Select a returned model ID. Hermes remains available and cannot be deleted; deleting
the active custom model selects the same fallback as the UI. No text generation is
requested by switching, although the existing backend may perform a status check.
`models.create` requires `profile: {id, name, base, model}`: all four are nonempty
strings; generate a unique custom `id`. Its connection test requires model-call
authorization. `models.list` omits `base`; obtain it from the user's approved
configuration, never guess it. Use approved credentials without echoing them.
`models.select` only selects an existing profile.

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
For deletion, call `nora.world.delete_preview` and explain its current scope:
exclusive resources and all confidently owned chat backups, including protected
ones, will be deleted; shared/unknown files and separately managed update rollback
packages remain. After confirmation, pass the preview token as `expectedPlan`
to `nora.world.delete`. A changed plan requires a fresh preview and confirmation.
Use the supported operation, its idempotencyKey and returned receipt. Repair is
not a general story rewrite. Delete only the world the user selected; do not infer
permission to delete its library source, sibling worlds or persistent instance data.
Verify the resulting world state/list and operation outcome.
