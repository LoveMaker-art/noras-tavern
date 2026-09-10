# Card Authoring

Read this reference for original cards or substantial prose rewrites. It adapts
the `card.md` discipline from Foreverse's character-card-skills under CC BY 4.0.

## Brief

Resolve these before drafting:

- Character identity and the contradiction that makes them behave differently.
- The user's role and what each side can reasonably know at the opening.
- The current event that puts them together now.
- The intended relationship or play experience without promising a fixed ending.
- Content boundaries, point of view, language, and target audience tags.

Ask only for choices that materially change the card. Keep undecided cosmetic
details editable rather than blocking the build.

## Field Ownership

- `Description`: durable identity, appearance, history, relationships, and facts.
- `Personality`: decision tendencies, values, boundaries, flaws, and speech cues.
- `Scenario`: the current playable situation, not a complete plot synopsis.
- `First Message`: an active scene that hands agency to the user.
- `Example Dialogue`: repeatable voice and reaction patterns, not canon events.
- `Lorebook`: conditional shared facts and behavior rules that should not remain
  permanently in the base description.
- `Creator Notes`: user-facing premise, controls, attribution, and content notes.

Keep the same fact in one owner. Put mutable story state in runtime variables or
the active World, never in a reusable character biography.

## Opening Gate

The first message should establish place, immediate event, character action,
recognizable voice, and a clean opening for the user. It may observe visible user
context supplied by the premise. It must not decide the user's thoughts, speech,
consent, movement, or emotional response.

Use an alternate greeting to change time, location, or relationship temperature,
not merely paraphrase the first message.

## Dialogue Gate

Write at least two `{{user}}` and `{{char}}` exchanges when the card depends on a
specific voice. Demonstrate disagreement, uncertainty, and ordinary behavior as
well as charm. A character should be able to refuse, misunderstand, change topic,
or pursue a goal without becoming random.

## Lorebook Gate

Use concrete trigger keys. A short generic key needs secondary keys. Keep constant
entries for rules needed every turn; keep biographies, places, events, and minor
characters conditional. Split unrelated facts so token budgeting can discard one
entry without losing an entire setting.

The supported heading format is:

```markdown
### Entry | keys: a, b | order: 250 | position: before_char
### Rule | constant | order: 900 | recursion: exclude
```

Advanced directives are documented in `card-project-format.md`.

## Review Loop

Run `build --profile release` after a coherent draft. Treat the deterministic
writing score as a diagnostic, not a substitute for the user's intended style.
Repair concrete issues while preserving voice. Use `release-strict` only for a
release candidate that the user expects to meet the 75-point publication gate.

Attribution: Based on character-card-skills by the Foreverse team
(https://foreverse.app), CC BY 4.0. Adapted for Nora's project and runtime model.
