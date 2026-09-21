# Card Project Format

Read this reference when authoring a new project's `card.project.json` and
feature files. Imported-source fields below document retained project tooling;
ordinary existing-card import passes original bytes, not a rebuilt project.

## Layout

```text
card.md                    Authored prose and lore
card.project.json          Build policy and relative feature paths
assets/cover.png           Optional cover for PNG output
features/mvu.json          Optional authored MVU variable specification
features/statusbar.html    Optional authored fixed status template
source/original.*          Immutable imported artifact
source/passthrough.json    Imported card used as the round-trip base
source/extracted-*         Read-only advanced-feature summaries
build/                     Generated artifacts
reports/                   Quality and build evidence
```

The program rejects project paths that escape the project root. `init` and
`ingest` require an empty destination directory.

## Configuration

`format` must remain `nora-card-project/v1`. `slug` is lowercase ASCII letters,
digits, and hyphens. Feature paths are relative to the project root.

```json
{
  "format": "nora-card-project/v1",
  "slug": "example-card",
  "world": {
    "persona": { "name": "", "description": "" },
    "characters": []
  },
  "source": {
    "type": "new",
    "original": null,
    "passthrough": null
  },
  "build": {
    "profile": "release",
    "target": "v2-json+v3-png",
    "cover": "assets/cover.png"
  },
  "features": {
    "mvu": "features/mvu.json",
    "statusbar": "features/statusbar.html"
  }
}
```

Feature settings have distinct meanings:

| Setting | Actual build behavior |
| --- | --- |
| Relative path string | Read the feature file; an explicitly configured missing file fails the build. |
| Object with `path` | Read the specified relative file unless `enabled` is false. |
| `false` or `{ "enabled": false }` | Disable compiling this authored feature. Does not delete an imported script or live state. |
| `null`, omitted, or object without `path` | Auto-discover `features/mvu.json` or `features/statusbar.html` if present. Not an explicit disable switch. |

Ingested advanced features remain in the passthrough card by default; extracted
summaries are not automatically recompiled because recompilation would change
third-party technical content.

Other configuration fields:

| Field | Meaning and boundary |
| --- | --- |
| `source.type` | Provenance label such as `new` or `imported`, not a live runtime mode. |
| `source.original` | Original artifact path; an imported PNG can also supply a cover. |
| `source.passthrough` | Base JSON for rebuilding with imported fields. Not a chat-variable snapshot. |
| `build.profile` | `release` checks technical gates; add CLI `--score-writing` for advisory scoring. `release-strict` runs and gates the score. CLI `--profile` takes precedence. |
| `build.target` | Current generated label `v2-json+v3-png`; the builder does not branch on this field. Changing the string does not select another exporter. |
| `build.cover` | Cover path. Without an available cover or original PNG, the build emits JSON only. |
| `mvu.keepFloors` | Integer 0..1000, default 3; emits a prompt-filter Regex with `minDepth = keepFloors * 2`. It is not a stored-state retention policy. |
| `mvu.protocol` | New projects require `nora-mvu/1` (also the default) and carry an upstream JSONPatch baseline. Retained imported-project tooling defaults to `legacy`. The enabled worldbook comment opts into Nora enhancements; its explicitly marked fallback format stays available in upstream MVU. Inline/extra-model remains a program setting. This applies only to feature compilation, not original-file import. |
| `statusbar.mode` | New field-contract UI requires `mvu` (default). The placeholder hosts HTML/CSS and custom scripts; literal field bindings optionally add a generated reader. Retained legacy tooling has a `text` mode; it is not the new-card authoring standard. |

MVU build options other than `protocol` and `keepFloors` are rejected. Do not use
the former, ineffective `injectMode` option. Variable files must follow
[nora-mvu-fields/v1](variable-reference.md); status templates must follow
[typed bindings](advanced-cards.md). These are authoring inputs, not model wire envelopes.
`project-inspect` parses the prose, World cast and passthrough base without compiling
MVU/statusbar feature files. Its summary is not the final build's feature inventory.

The successful manifest binds artifact hashes to hashes of project sources outside
`build/` and `reports/`. Source changes require rebuilding before `prepare-import`.
Each build invalidates the previous manifest first; failed builds may leave old
artifacts on disk, but they are not eligible for staging. Existing projects whose
manifests lack source hashes must rebuild. Original-file import does not use this gate.

## New World persona and cast

New projects place this `world` object in `card.project.json`. It is the only
authored copy of the player and actors; it is not MVU state:

```json
{
  "world": {
    "persona": { "name": "旅人", "description": "受委托送信的成年旅人。" },
    "characters": [
      { "id": "guide", "name": "向导", "description": "熟悉沿途道路。", "personality": "谨慎直率。", "activation": { "mode": "constant" } },
      { "id": "merchant", "name": "商人", "description": "在车站出售地图。", "activation": { "mode": "triggered", "keys": ["商店", "买地图"] } }
    ]
  }
}
```

Persona requires string `name` and `description`; both can be empty when the user
will choose their own identity. Characters require unique stable `id`, nonempty
`name` and `description`; `personality` is optional. Never use `__user__` as an
actor ID. Keep IDs when reordering or renaming actors. Activation defaults to
`constant`; `triggered` requires nonempty `keys`. Optional activation properties
match the current World cast API: `enabled`, `secondaryKeys`, `selectiveLogic`
(0..3), `scanDepth` (0..1000), `sticky`, `cooldown`, `delay` (nonnegative integers),
`caseSensitive`, `matchWholeWords` (booleans). Unknown keys fail instead of vanishing.
Set optional `world.language` to `zh` (default), `zh-Hant`, or `en` for Nora's cast prompt.

The compiler emits `data.extensions.nora_world` with format `nora-world-card/2`
and the `story_context` snapshot carrying the same `card_format`. Nora imports
persona into 我的角色 and actors into 角色设定. No player or actor lore copies are generated.
The format identifies a Nora World card, not a portable single-character ST card.

`card.md` Description is the reader-facing World summary: it remains in the file
and UI but is excluded from model prompt fields. Whole-card Personality/Scenario
must be empty; the compiler rejects nonempty values rather than silently discarding
them. Author traits in `world.characters`, background/gameplay/initial circumstances
in Lorebook, and the playable opening in First Message. The summary cannot be the
only location of a necessary rule. Original-file import does not run this compiler.
`{{char}}` inside an actor's description/personality refers to that actor; outside
actor definitions it names the World. Use `{{char::guide}}` to reference the actor
whose stable ID is `guide`, even after renaming or reordering; it does not activate
that actor by itself. Do not use array indexes or treat bare `{{char}}` as every actor.

## Lorebook Directives

These belong to worldbook entry headers in `card.md`, not to MVU state.
For MVU cards, `[mvu_plot]` is a prefix in the entry title/comment, not a pipe
directive or text in the body. Generated field rules use `[mvu_update]`. See
[MVU lore routing](card-authoring.md#mvu-lore-routing) for ownership and mode behavior.
Example:

```markdown
### 雨夜车站 | keys: 车站, 末班车 | secondary: 下雨 | logic: and_any | order: 100 | prob: 100
车站已关闭，仅剩值班人员。
```

| Directive | Meaning / emitted field |
| --- | --- |
| `keys` | Comma-separated primary triggers -> `keys`. The parser promotes entries without keys to `constant`. |
| `secondary` | Additional keyword filter -> `secondary_keys`; nonempty filters set `selective`. |
| `constant` | Keyword-independent activation, still subject to runtime enablement/budget/other applicable filters. |
| `order` | Insertion order -> `insertion_order`, default 100; not narrative importance or a stat. |
| `position` | `before_char` / `after_char`: placement around character definitions. |
| `depth` | Sets `extensions.depth` and depth-placement code `extensions.position = 4`; not keyword scan depth. |
| `role` | Depth-message role `system`, `user`, `assistant` -> codes 0, 1, 2; not character identity. |
| `logic` | Secondary-filter rule: `and_any` any present, `and_all` all present, `not_any` none present, `not_all` not all present. Emitted codes 0, 3, 2, 1 respectively. |
| `prob` | Activation probability 0..100 -> `probability` with `useProbability`; not a percentage chance of a story outcome. |
| `sticky` | Duration to remain active after triggering -> `extensions.sticky`. |
| `cooldown` | Duration before reactivation -> `extensions.cooldown`. |
| `recursion: exclude` | Set `exclude_recursion`: avoid activation by other entries. |
| `recursion: prevent` | Set `prevent_recursion`: avoid triggering further entries from this entry. |
| `group` | Inclusion-group name -> `extensions.group`; unrelated to MVU `group`. |
| `weight` | Relative selection weight -> `group_weight`; not a percentage or guaranteed winner. |
| `regex` | Emit `use_regex` for trigger matching; not a replacement script. |

Runtime meanings follow [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/),
not a promise about Nora's runtime. Sticky/cooldown use messages, not dialogue
pairs; zero disables the timed effect. Budget, global settings, and target version
can affect activation. This Markdown parser rejects unknown directives, missing
values and invalid enum values, identifying the entry and directive. `constant`
and `regex` are bare flags. Numeric values must be complete safe integers;
`depth`, `sticky`, `cooldown` and `weight` are nonnegative, `prob` is 0..100.
An omitted `keys` still defaults to constant; an explicitly empty `keys` is an error.
These are authoring checks, not proof of runtime activation or budget behavior.

Unknown card fields are preserved by the passthrough base.
V2/V3 exports remove the six deprecated top-level V1 narrative aliases (name,
description, personality, scenario, first_mes, mes_example); their canonical
values stay in `data`. This avoids ST's V1-first validator misclassifying JSON.
Other unknown root and extension metadata remains preserved. Authored standard
fields and a present Lorebook section override their corresponding imported
fields; omitted advanced extensions remain untouched. The Markdown lorebook is
not a lossless editor for every third-party entry attribute: inspect reconstructed
entries before claiming a full round trip.

Source: [project engine](../src/project/project-engine.js),
[Markdown parser](../src/card-md/card-md.js). Plugin parameter explanations are in
[feature-explanations.md](feature-explanations.md); state-variable parameters are
in [variable-reference.md](variable-reference.md).
