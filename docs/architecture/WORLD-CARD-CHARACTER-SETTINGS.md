# World Card character settings

## Scope

World Cards contain independent character profiles. The UI presents My Character,
Character Settings and World Settings. This is not ST group chat: one generation
can portray several characters. It does not change the MVU output protocol.

## Authoritative data

World manifests store the existing `story_context.characters` array. Every member
has a stable `id`, `profile.identity.name`, optional profile description/personality,
`persistent_status`, and optional `activation`. An omitted activation keeps the
previous constant behaviour. My Character remains the World's persona. MVU chat
state is not copied into or deleted with these profiles.

```json
{
  "id": "actor:merchant",
  "profile": {
    "identity": {"name": "机械商人", "description": "维修机械的商人"},
    "personality": {"summary": "谨慎、话少"}
  },
  "persistent_status": {},
  "activation": {"mode": "triggered", "keys": ["机械商店"], "scanDepth": 4}
}
```

`activation.mode` is `constant` or `triggered`. Triggered members require nonempty
`keys`. Optional `secondaryKeys`, `selectiveLogic` (ST 0–3), `scanDepth`, `sticky`,
`cooldown`, `delay`, `caseSensitive`, and `matchWholeWords` use ST semantics. Null
scan depth follows the user's World Info setting. Timed effects count messages,
not seconds or story turns. Keywords indicate relevance, not physical presence.

## Save and prompt paths

- The existing World PATCH endpoint accepts `character: {operation, id, patch}`.
  Operations are `create`, `update` (also the old implicit default), and `delete`.
  All mutations require the current revision. Delete also removes relationship
  edges referencing that ID, but never deletes chat, MVU state or runtime cards.
- Constant profiles use the existing `nora_world_story_context` prompt. Triggered
  full profiles are excluded from it; relevant relationship references are not.
- Triggered profiles are projected as transient character-lore entries into ST's
  existing scanner. No duplicate lorebook file is created. They use World Info
  before-character placement, normal WI budget, no random probability, and no
  recursive activation. Trigger rules never mutate the saved profile.
- Per-profile `{{char}}` resolves to that profile's name; `{{user}}` remains for ST
  to resolve. The old runtime card's macro behaviour stays unchanged.
- Each prompt carries direct relationships involving its selected profiles (and
  the player when included), regardless of the other participant's activation.
  The other participant gets an ID/name-only `referenced_characters` entry, not
  their full profile. `__user__` remains the reserved player identity. Unrelated
  relationships and transitive relationship chains are excluded. Neither profile
  injection nor a relationship reference denotes physical presence or updates MVU.
  This is prompt-only projection: saved profiles and relationship records stay intact.
  Separate activated entries can repeat a shared relationship; no new global
  deduplication pass or budget bypass is introduced.
- Switching/closing Worlds replaces/clears the page's transient projection. It is
  shared by product bundles and ST import-map modules, not persisted in settings.

## Import and compatibility

### Stable character references

`{{char::character:UUID}}` selects a name by the existing character ID, scoped to
the current World. IDs are not array indices. Renaming and sorting preserve the
reference. New profiles already receive UUID IDs; there is no additional numeric
alias registry. The Character Settings panel provides Copy Reference (or a
selectable text field if clipboard access fails). Legacy-card rows have no such
button because they are not members of the World character array.

The shared pure resolver serves profile rendering and both ST macro engines.
Plain `{{char}}`/`{{user}}` keep their existing semantics. Worldbook content uses
the normal ST substitution path. Resolving a name never injects that character's
profile or changes its activation settings. Existing ST keyword matching and
recursion still apply normally to substituted text.

Nora character/world-setting editors validate references before saving. Missing
IDs (including deleted actors) render an explicit invalid-reference marker at
runtime, rather than another actor's name or an empty string. Deletion warns that
references may need repair. These checks do not rewrite saved source text or
scan/log the whole library in the background. Direct API/import callers are not
blocked from saving incomplete authoring drafts; runtime markers still apply.

New PNG/JSON World Cards may supply a complete schema-version-1 story context at
`data.extensions.nora_world.story_context`. It is validated before runtime files
are created, then copied into the World manifest. The selected player persona
takes precedence over imported player identity.

Old ST cards keep their original description/personality/scenario prompts,
Worldbooks, scripts, regex and MVU data. The UI labels their editable legacy fields
separately. No automatic guessing/splitting of prose or migration of Worldbook NPC
entries occurs. Authors must not duplicate the same profile in old fields and the
new array: the engine preserves both explicit sources, it does not guess identity.

Editing a World's profiles changes that World, not the original library artifact.
This change does not add an export-current-World facility. Existing library export
continues exporting its own artifact, not the edited World manifest.

## Verification boundary

Targeted checks cover array persistence, optimistic revisions, import validation,
legacy resource preservation, prompt filtering and the actual ST keyword scanner.
No browser interaction or paid model generation is performed by these checks.

## Main-branch integration boundary (2026-09-09)

The character changes were extracted onto main at `28b93a7`, not merged together
with the MVU experiment. Main's isolated Worldbook editing remains intact.
MVU runtime/protocol/retries/diagnostics, helper bundles, model settings, cookies
and startup changes are excluded. Production assets are rebuilt from main, not
copied from the experiment; the inline bundle differs only in the six character,
macro and World Info modules involved in this feature.

The 101 focused character, World Core, import, adapter and Worldbook regression
tests passed, as did the World Core and production-bundle contracts and the
Story Profile consistency check. The World Core contract also now checks main's
existing pure `worldbook-bindings.js` module instead of mistaking it for a browser
adapter. Build warnings concern the existing unchanged `lib-core.js` size.
These checks do not establish browser visual acceptance or live model behaviour.
