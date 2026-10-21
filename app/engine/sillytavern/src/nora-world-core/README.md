# NoraWorldCore

`NoraWorldCore` owns authoritative World identity, resource ownership and durable
World operations. It has no browser, ST DOM or route dependency. Product behavior
and acceptance belong to the [Tavern product design](../../../../../docs/product/tavern.md); this file
explains the implementation boundary, not a separate product policy or rollout
status. The previous numbered-phase descriptions are historical, not a current
list of missing features.

## Interface and callers

Callers import `createNoraWorldCore()` from [index.js](index.js). That exported
facade is the current method inventory; [service.js](service.js) composes the
implementations. Its responsibilities are:

| Area | Facade operations |
| --- | --- |
| Full-card library | `listLibraryCards`, `saveLibraryCard`, `manageLibraryCard`, `readLibraryCardSource`, `deleteLibraryCard` |
| Profile and Worldbook libraries | `listLibraryProfiles`, `readLibraryProfile`, `saveLibraryProfile`, `deleteLibraryProfile`, `listLibraryWorldbooks`, `readLibraryWorldbook`, `saveLibraryWorldbook`, `deleteLibraryWorldbook`, `importLibraryItem` |
| World creation and restart | `submitWorld`, `createWorld`, `restartWorld` |
| Durable operation inspection and retry | `getOperation`, `retryOperation` |
| World read, open and edit | `getWorld`, `listWorlds`, `prepareOpen`, `updateWorld`, `editWorldbookEntry`, `addWorldSetting`, `setWorldTheme` |
| Deletion, inspection and repair | `previewWorldDeletion`, `deleteWorld`, `inspectWorld`, `repairWorld` |
| Independent capability attempts | `beginCapabilityAttempt`, `settleCapabilityAttempt` |

The HTTP adapter is [nora-worlds-v2.js](../endpoints/nora-worlds-v2.js). Browser
clients and MCP use the appropriate business endpoints; a backend method does
not imply a visible UI button. Global theme, asset and storage inventory routes
also compose other modules, so route count and facade count are different.
Callers supply the supported command, target and expected revision, not their
own resource paths, ownership claims or deletion plans.

## Creation, materialization and persistence

[st-backend-materializer.js](st-backend-materializer.js) hides compatibility-engine
card decoding, resource construction, chat serialization, setting edits and
resource inspection/deletion. Staged input is checked against its allowed root,
file type, declared format and digest before use. A durable command contains
non-secret staging references, not raw card bytes, credentials, authorization
headers or browser objects. Refer to [st-card-codec.js](st-card-codec.js) for the
actual supported input formats rather than inferring them from a file picker.

One idempotency key plus the same command resolves to one operation and World;
reusing a key with a different command conflicts. A new key may intentionally
create another World from the same source. Materialization and staged-input
release must remain safe when resumed after an interrupted journal write.
Automatic transport retry and a user's new form submission are different entry
points; the facade's idempotency contract alone does not prove every UI resubmit
retains the original intent.

[store.js](store.js), [operation-journal.js](operation-journal.js) and
[mutation-journal.js](mutation-journal.js) manage manifests and operation stages.
The persistence roots include `worlds/`, `operations/`, `mutations/` and the
corresponding `quarantine/` records. Atomic JSON writes use same-directory
replacement and file synchronization; these primitives do not establish a
universal guarantee against disk loss. A committed manifest and its creation
identity support reconciliation of interrupted operation records. Invalid
records retain repair evidence rather than being treated as new empty data.

## Identity, libraries and resource ownership

World, Story Session and Resource IDs are Nora identities; ST avatar and chat
names are engine bindings. Library originals, per-World runtime resources and
sessions have distinct ownership. Card-library content deduplication does not
merge new Worlds or their mutable resources.

New creation allocates owned runtime cards, sessions and independent Worldbooks,
including repeated imports from the same original. Restart copies the supported
source configuration into another World without replacing its source story.
The earlier rule that all newly embedded Worldbooks are shared is obsolete.
Legacy shared/external bindings remain protected. Editing checks the actual
World revision, resource ownership and references; copying an applicable legacy
resource for a write is different from silently migrating all old Worlds.

[worldbook-references.js](worldbook-references.js), the library modules and
[resource-catalog.js](resource-catalog.js) provide their respective reference and
source checks. One resource identity cannot silently claim conflicting bindings.
Failure compensation only releases the operation's verified owned effects;
matching names or content alone do not authorize deletion of another resource.

## Opening and capability results

An activation plan verifies World, Story Session, runtime card and engine chat
bindings. Selection commits and stale selection responses are handled at the
client/runtime boundary, not by creating substitute Worlds.

Base World readiness is separate from Helper, regex and MVU readiness. The
browser capability controller authorizes the applicable content and starts and
settles each declared capability attempt through World Core. Attempts retain
identity, result and evidence; an old completion cannot overwrite a newer retry.
A capability problem can degrade that capability without deleting or recreating
an otherwise valid World. Runtime availability is not proof of a particular
turn's variable update or permission to run untrusted scripts.

## Mutations and historical data

Deletion requires the backend preview and current confirmed plan. The backend
computes references and owned effects, persists progress and resumes the same
operation after interruption. World-owned chat backups, including protected
ones, are part of the previewed scope; shared resources, library originals,
unknown files and independent program-recovery packages are outside it. Deleted
World manifests remain tombstones for reconciliation and disappear from the
normal authoritative list.

Repair inspects resource files, identity and conflicting bindings without
rewriting story content. Returning to ready requires positive evidence; repair
failure is not permission to rebuild or delete the World.

[legacy-migration.js](legacy-migration.js) and the dedicated migration command
analyze legacy records before an explicitly requested apply. They are not a
second active World authority or an automatic cleanup of similarly named data.
The current [Story Profile bridge](../nora-story-profile.js) resolves Worlds
through World Core; the former v1 rollback-reader description is obsolete.
Target-device acceptance, data migration and rollout status must be reported
separately for the actual source and environment.
