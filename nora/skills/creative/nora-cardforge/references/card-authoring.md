# Card Authoring

Read this reference for new cards and their draft refinement. It adapts
the `card.md` discipline from Foreverse's character-card-skills under CC BY 4.0.

## Brief

Resolve these before drafting:

- The World's premise, core play loop and participating actors.
- The player's role and what each participant can reasonably know at the opening.
- The current event that starts play.
- The intended relationship or play experience without promising a fixed ending.
- Content boundaries, point of view, language, and target audience tags.

Ask only for choices that materially change the card. Keep undecided cosmetic
details editable rather than blocking the build.

## Field Ownership

- `card.project.json → world.persona`: the player's chosen identity, shown in 我的角色.
- `world.characters[]`: other actors, each with ID, name, description, optional personality and activation.
  Description holds identity/history/facts; personality holds tendencies, boundaries and voice.
  Each actor is authored once; the compiler emits no duplicate lore biography.
- `Description` in `card.md`: a reader-facing summary of the theme, play experience and controls.
  It is not injected into the model. Every fact needed for play must also have its authoritative
  definition in the cast, player identity or world lore; a teaser is not a rule definition.
- Whole-card `Personality` and `Scenario` stay empty. Put actor traits in the cast and
  the initial situation, world background and narration rules in appropriately activated lore.
  See the [project schema](card-project-format.md#new-world-persona-and-cast).
- `First Message`: an active scene that hands agency to the user.
- `Example Dialogue`: repeatable voice and reaction patterns, not canon events.
- `Lorebook`: world background, gameplay/narration rules and conditional places/events.
  Rules needed every turn use constant entries. Characters belong in the cast array.
- `Creator Notes`: user-facing premise, controls, attribution, and content notes.

Keep the same fact in one owner. Put mutable story state in runtime variables or
the active World, never in a reusable character biography.
Review the play instructions without the reader summary: every required rule and character
must still be defined, with activation conditions that make it available when needed.

## Opening Gate

The first message should establish place, immediate event, character action,
recognizable voice, and a clean opening for the user. It may observe visible user
context supplied by the premise. It must not decide the user's thoughts, speech,
consent, movement, or emotional response.

Use an alternate greeting to change time, location, or relationship temperature,
not merely paraphrase the first message.

## Dialogue Gate

When examples are needed, demonstrate the World's narration and named actors'
voices, not a single personality for the whole World. In dialogue framing,
`{{user}}` is the player and bare `{{char}}` names the World/narrator; refer to an
individual actor in the body by name or `{{char::<stable-id>}}`.
Demonstrate disagreement, uncertainty, and ordinary behavior as
well as charm. A character should be able to refuse, misunderstand, change topic,
or pursue a goal without becoming random.

## Lorebook Gate

Use concrete trigger keys. A short generic key needs secondary keys. Keep constant
entries for rules needed every turn; keep places and events conditional. Set
minor characters to triggered in the cast array. Split unrelated facts so token budgeting can discard one
entry without losing an entire setting.

The supported heading format is:

```markdown
### Entry | keys: a, b | order: 250 | position: before_char
### Rule | constant | order: 900 | recursion: exclude
```

Advanced directives are documented in `card-project-format.md`.

### MVU Lore Routing

For new MVU cards, decide the consumer of each instruction before writing its
entry. Use the existing MVU comment markers, not a new format or keyword guess:

| Content | Authoring location | Extra-model mode |
| --- | --- | --- |
| Narrator role, prose style, viewpoint, dialogue/length requirements | `### [mvu_plot]叙事规则 ...` in `card.md` | Story model only |
| Field meaning, update conditions, units and bounds | `features/mvu.json` | Compiler emits `[mvu_update][nora_mvu/1]`; variable model only |
| World facts and gameplay conditions needed to understand actions | Unmarked lore entries; actors remain in `world.characters[]` | Available to both models, subject to activation and budget |

The marker belongs to the entry **heading/comment**, not its body. For example:

```markdown
### [mvu_plot]叙事规则 | constant | order: 100
用第三人称描述已发生的行动和可见后果，保持简洁，为玩家留下选择。

### 旅行条件 | constant | order: 110
前往车站需要10点能量；不足时只能休息或补给。
```

The energy field definition describes the corresponding state update: deduct 10
only when that journey actually happened. Do not hide this condition inside the
prose-style entry, or ask the variable model to write the next scene. If a draft
entry mixes biography, gameplay and writing instructions, split it by meaning:
retain shared facts, move only pure writing instructions to `[mvu_plot]`, and put
field updates in the field definition. Do not label the entire mixed entry plot-only.

Review the two resulting views: the story model must retain the facts and action
conditions needed to narrate; the variable model must retain the evidence and
conditions needed to update, without instructions to continue the story. The
compiler preserves markers and generates variable entries; it does not infer
which natural-language sentences are prose instructions. This semantic review is
an authoring check, not something a successful build proves.

In inline mode the original MVU router retains both types for the one combined
request. No-MVU cards need no routing marks. This is a new-card authoring rule,
not authorization to rewrite existing cards. User-selected model presets can
also inject instructions; card entry markers do not filter preset content.

## Review Loop

Run `build --profile release` after a coherent draft. It checks technical gates
without invoking the writing scorer. When the user asks for a score, add
`--score-writing`; treat it as a diagnostic, not a substitute for intended style.
Repair concrete issues while preserving voice. Use `release-strict` only for a
release candidate that the user expects to meet the 75-point publication gate.

Attribution: Based on character-card-skills by the Foreverse team
(https://foreverse.app), CC BY 4.0. Adapted for Nora's project and runtime model.
