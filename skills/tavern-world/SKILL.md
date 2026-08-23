---
name: tavern-world
description: Build and manage Tavern worlds, cards, lore, and Personas.
version: 1.24.5
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, world, character-card, worldbook, persona, 世界, 角色卡, 世界书]
    category: creative
---

# Tavern World

## Scope

Use this skill for a complete playable world or for one reusable component:
character card, worldbook, Persona, or opening. Do not create a world when the
user only asked to prepare a reusable card or worldbook.

Route model/deployment work to `tavern-ops`, long-story state repair to
`tavern-continuity`, memory to `tavern-story-profile`, and themes to
`tavern-world-visuals`.

## Workflow

1. Inspect current state with `list --json`. Research before inventing when the
   user asks for existing or canonical material.
2. Classify every fact into one owner: character card, worldbook, Persona,
   opening, or live story state.
3. For an external card, require a real V1/V2/V3 JSON, PNG/APNG, or V3 CHARX
   artifact. Run `inspect-card --json`, then `prepare-card --output <plan>`.
   Preparation must yield a non-empty main profile and preserve provenance.
4. Show a compact preview. Apply the same preparation plan only after approval
   with `apply-card-plan --confirm`.
5. For original material, author a canonical V2 card or world manifest from
   explicit evidence. Leave unknown structured fields empty; do not guess.
6. For a complete world, preview one manifest with `build-world <manifest>`.
   Apply that same file once with a stable request ID.
7. Verify the stored result. Treat JSON identifiers and `verification.ok` as
   authoritative, then return the bare Tavern URL from `app-link`.

## Commands

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py"
python3 "$CLI" list --json
python3 "$CLI" search "query"
python3 "$CLI" inspect-card <artifact> --json
python3 "$CLI" prepare-card <artifact> --output /tmp/card-plan.json --json
python3 "$CLI" apply-card-plan /tmp/card-plan.json --confirm
python3 "$CLI" add-original <card-json>
python3 "$CLI" add-worldbook <worldbook-json>
python3 "$CLI" card-audit <card>
python3 "$CLI" lore-audit <world> --json
python3 "$CLI" build-world <manifest-json>
python3 "$CLI" build-world <manifest-json> --apply --confirm --request-id <stable-id> --json
python3 "$CLI" verify-world <world> --json
python3 "$CLI" attach-card <world> <card> --json
python3 "$CLI" add-lore <world> "setting" --json
python3 "$CLI" app-link --app console --json
```

## References

Load only the needed reference:

- `references/world-workflow.md`: ownership, planning, manifest, expansion, rebuild.
- `references/card-workflow.md`: external formats, normalization, authoring, localization.
- `references/worldbook-workflow.md`: lore fields, triggers, audit, repair.
- `tavern/references/conversation-cards.md`: concise chat presentation.
- `tavern/references/shared-contract.md`: required before a write.

## Guardrails

- External cards must pass inspection and preparation; never route them through
  `add-original` or directly into `build-world`.
- Imported scripts, regex executors, MVU/TavernHelper blocks, and executable
  assets are unsupported and removed. Never claim they will run.
- The reusable library card is not the same as a world's evolving runtime cast.
- User identity belongs in world-local Persona, not a character card or generic lore.
- Do not put global output-format rules in cards, lore, notes, or story history.
- Never edit production, card, or worldbook JSON directly.
- Never create replacement worlds as an error-recovery shortcut.

## Done When

Exactly the intended world or reusable item changed; cast, lore, Persona, and
opening match the approved plan; verification passes; unrelated state is intact.
